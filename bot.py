"""
AI Paper-Trading Bot
--------------------
Uses a machine learning model (Random Forest) to predict whether a stock will
go up tomorrow, then trades on Alpaca's PAPER (fake money) account.

Usage:
    python bot.py backtest   -> test the strategy on past data (no trading)
    python bot.py trade      -> make today's prediction and place a paper trade
    python bot.py status     -> see account value, positions and progress vs SPY
"""

import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta

import pandas as pd
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier

from alpaca.data.enums import DataFeed
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import GetOrdersRequest, MarketOrderRequest, StopOrderRequest

# ---------------- Settings you can tweak ----------------
SYMBOL = "SPY"          # what to trade (SPY = S&P 500 ETF)
YEARS_OF_DATA = 8       # how much history to learn from
BUY_THRESHOLD = 0.53    # backtest only: buy if model is >53% confident of an up day
TRAIN_FRACTION = 0.8    # backtest: train on first 80%, test on last 20%

# Claude decides how much SPY to hold each day, inside these limits:
CLAUDE_MODEL = "claude-opus-5-5"
BASE_PCT = 0.05         # normally keep about 5% of the account in SPY
BIG_DOLLARS = 20_000    # when Claude sees a big opportunity, go up to this much SPY
MAX_LOSS = 1_000        # a big bet may never risk losing more than this (enforced by a stop-loss)
MIN_STOP_PCT = 0.01     # Claude picks the stop-loss distance, but between 1%...
MAX_STOP_PCT = 0.10     # ...and 10% below today's price
# ---------------------------------------------------------

load_dotenv()
API_KEY = os.getenv("ALPACA_API_KEY")
SECRET_KEY = os.getenv("ALPACA_SECRET_KEY")

FEATURES = [
    "ret_1", "ret_5", "ret_10", "ret_20",
    "sma_ratio_20", "sma_ratio_50",
    "volatility_20", "volume_ratio",
]


def check_keys():
    if not API_KEY or not SECRET_KEY:
        sys.exit("Missing API keys. Copy .env.example to .env and add your Alpaca PAPER keys.")
    # Alpaca paper keys start with "PK". This guard stops you from accidentally using live keys.
    if not API_KEY.startswith("PK"):
        sys.exit("These don't look like PAPER trading keys (they should start with 'PK'). Stopping for safety.")


def get_prices(symbol):
    """Download daily price bars from Alpaca (free IEX feed)."""
    client = StockHistoricalDataClient(API_KEY, SECRET_KEY)
    request = StockBarsRequest(
        symbol_or_symbols=symbol,
        timeframe=TimeFrame.Day,
        start=datetime.now() - timedelta(days=365 * YEARS_OF_DATA),
        feed=DataFeed.IEX,
    )
    df = client.get_stock_bars(request).df
    df = df.xs(symbol, level="symbol")
    return df[["open", "high", "low", "close", "volume"]]


def make_features(df):
    """Turn raw prices into signals the model can learn from."""
    d = df.copy()
    close = d["close"]

    # Momentum: how much the price moved over the last N days
    d["ret_1"] = close.pct_change(1)
    d["ret_5"] = close.pct_change(5)
    d["ret_10"] = close.pct_change(10)
    d["ret_20"] = close.pct_change(20)

    # Trend: how far price is above/below its moving averages
    d["sma_ratio_20"] = close / close.rolling(20).mean() - 1
    d["sma_ratio_50"] = close / close.rolling(50).mean() - 1

    # Risk and activity
    d["volatility_20"] = d["ret_1"].rolling(20).std()
    d["volume_ratio"] = d["volume"] / d["volume"].rolling(20).mean()

    # What we're trying to predict: did the price go up the NEXT day?
    d["next_ret"] = close.pct_change().shift(-1)
    d["target"] = (d["next_ret"] > 0).astype(int)
    return d


def build_model():
    return RandomForestClassifier(
        n_estimators=300,
        max_depth=5,          # shallow trees = less overfitting
        min_samples_leaf=20,
        random_state=42,
    )


def backtest():
    """Train on older data, then see how the strategy would have done on newer data."""
    data = make_features(get_prices(SYMBOL)).dropna(subset=FEATURES + ["next_ret"])
    split = int(len(data) * TRAIN_FRACTION)
    train, test = data.iloc[:split], data.iloc[split:]

    model = build_model().fit(train[FEATURES], train["target"])
    prob_up = model.predict_proba(test[FEATURES])[:, 1]
    in_market = prob_up > BUY_THRESHOLD

    strategy_return = (1 + test["next_ret"] * in_market).prod() - 1
    buy_hold_return = (1 + test["next_ret"]).prod() - 1
    accuracy = ((prob_up > 0.5) == test["target"]).mean()
    up_day_rate = test["target"].mean()

    print(f"\n=== Backtest: {SYMBOL} ===")
    print(f"Trained on: {train.index[0].date()} to {train.index[-1].date()} ({len(train)} days)")
    print(f"Tested on:  {test.index[0].date()} to {test.index[-1].date()} ({len(test)} days)")
    print(f"\nModel accuracy:          {accuracy:.1%}")
    print(f"Always-guess-'up' rate:  {up_day_rate:.1%}   <- the model needs to beat this to be useful")
    print(f"Days in the market:      {in_market.mean():.1%}")
    print(f"\nAI strategy return:      {strategy_return:+.1%}")
    print(f"Buy-and-hold return:     {buy_hold_return:+.1%}")

    importances = pd.Series(model.feature_importances_, index=FEATURES).sort_values(ascending=False)
    print("\nWhat the model pays attention to most:")
    for name, value in importances.items():
        print(f"  {name:15s} {value:.3f}")

    print("\nNote: this ignores slippage and taxes, so real results would be a bit worse.")


def trade():
    """Ask Claude how much SPY to hold today, then adjust the paper position to match."""
    trading = TradingClient(API_KEY, SECRET_KEY, paper=True)  # paper=True is hard-coded on purpose

    # Skip weekends and market holidays.
    clock = trading.get_clock()
    if not market_trades_today(clock):
        print(f"\n{datetime.now():%Y-%m-%d %H:%M}  The market is closed today. Skipping, no trade.")
        return

    # Orders and stop-losses need the market open, so wait for the opening bell if it's close.
    if not clock.is_open:
        wait = (clock.next_open - clock.timestamp).total_seconds()
        if wait > 75 * 60:
            print("The market opens in more than 75 minutes. Run this again after it opens.")
            return
        print(f"The market opens in {wait / 60:.0f} minutes. Waiting...")
        time.sleep(wait + 90)

    data = make_features(get_prices(SYMBOL)).dropna(subset=FEATURES)
    train = data.dropna(subset=["next_ret"])
    model = build_model().fit(train[FEATURES], train["target"])

    latest = data.iloc[[-1]]
    price = float(latest["close"].iloc[0])
    prob_up = model.predict_proba(latest[FEATURES])[0, 1]
    print(f"\n{datetime.now():%Y-%m-%d %H:%M}  {SYMBOL}  latest bar: {latest.index[0].date()}  price ${price:,.2f}")
    print(f"Random Forest says chance of an up day: {prob_up:.1%}")

    qty = current_shares(trading)
    equity = float(trading.get_account().equity)

    decision = ask_claude(data, prob_up, qty, price, equity)
    plan = make_plan(decision, price, equity)
    print(f"Plan ({plan['decided_by']}): {plan['stance']} -> {plan['shares']} shares (~${plan['dollars']:,.0f})"
          + (f", stop-loss at ${plan['stop_price']:,.2f} (max loss ~${plan['max_loss']:,.0f})" if plan["stop_price"] else ""))
    print(f"Why: {plan['reason']}")

    # Cancel yesterday's stop-loss (and anything else still open) before changing the position.
    for order in trading.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[SYMBOL])):
        trading.cancel_order_by_id(order.id)
    time.sleep(2)

    change = round(plan["shares"] - qty, 6)
    if change > 0:
        action = "BUY"
        order = trading.submit_order(MarketOrderRequest(
            symbol=SYMBOL, qty=change, side=OrderSide.BUY, time_in_force=TimeInForce.DAY))
        print(f"BUY {change:g} shares")
    elif change < 0:
        action = "SELL"
        order = trading.submit_order(MarketOrderRequest(
            symbol=SYMBOL, qty=-change, side=OrderSide.SELL, time_in_force=TimeInForce.DAY))
        print(f"SELL {-change:g} shares")
    else:
        action = "HOLD" if qty > 0 else "CASH"
        order = None
        print("Already at the planned size, no trade needed.")

    filled = order is None or wait_for_fill(trading, order.id)
    held = current_shares(trading)

    # Protect a big bet with a stop-loss that stays in place until tomorrow's run replaces it.
    if plan["stop_price"] and filled and held >= 1:
        trading.submit_order(StopOrderRequest(
            symbol=SYMBOL, qty=int(held), side=OrderSide.SELL,
            time_in_force=TimeInForce.GTC, stop_price=plan["stop_price"]))
        print(f"Stop-loss placed: sell {int(held)} shares if {SYMBOL} falls to ${plan['stop_price']:,.2f}")
    elif plan["stop_price"]:
        print("WARNING: the order hasn't filled yet, so no stop-loss was placed today.")

    stamp = f"{datetime.now():%Y-%m-%d %H:%M}"
    log_run(stamp, prob_up, action, equity, price)
    log_claude(stamp, plan, held)
    print(f"Saved to {LOG_FILE} and {CLAUDE_LOG}.")

    log = pd.read_csv(LOG_FILE)
    first = log.iloc[0]
    bot_return = equity / first["equity"] - 1
    spy_return = price / first["spy_price"] - 1
    print(f"Now holding {held:g} shares of {SYMBOL} (~${held * price:,.0f}). Account: ${equity:,.0f} (fake money)")
    print(f"Score since {str(first['date'])[:10]}: AI {bot_return:+.1%} vs. just holding {SYMBOL} {spy_return:+.1%}")


def current_shares(trading):
    try:
        return float(trading.get_open_position(SYMBOL).qty)
    except Exception:
        return 0.0


def wait_for_fill(trading, order_id, timeout=120):
    """Market orders fill within seconds while the market is open."""
    for _ in range(timeout // 5):
        status = str(trading.get_order_by_id(order_id).status).lower()
        if "filled" in status and "partially" not in status:
            return True
        time.sleep(5)
    return False


CLAUDE_PROMPT = """You manage a PAPER trading account (fake money, a learning experiment) that holds only SPY.
Each trading morning you choose how much SPY to hold today:

- "base": hold about {base_pct:.0%} of the account (~${base_dollars:,.0f}). Choose this unless you see a strong reason to expect a meaningful rise.
- "big": hold about ${big_dollars:,.0f}. Choose this only when the evidence points to a meaningful rise, not just a small wobble.

For "big" you must also choose stop_loss_pct: how far SPY may fall (as a fraction, e.g. 0.03 = 3%) before the position is
sold automatically. It must be between {min_stop} and {max_stop}. The program shrinks the position if needed so the most it
can lose is ${max_loss:,.0f}, so a wide stop means a smaller position. For "base", set stop_loss_pct to 0.

Be honest about uncertainty: daily market moves are mostly noise, and "base" is the right default.
Give a one or two sentence reason in plain English for a beginner.

Account value: ${equity:,.0f}
Currently holding: {qty:g} shares of SPY (~${held_dollars:,.0f})
A Random Forest model (a hint, often near a coin flip) puts the chance of an up day at {prob_up:.1%}.

Recent daily SPY data, oldest first. ret_1/ret_5 = 1-day/5-day return, vs_sma20/vs_sma50 = price vs 20/50-day average,
vol20 = 20-day volatility, volume_x = volume vs its 20-day average:
{table}
"""

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "stance": {"type": "string", "enum": ["base", "big"]},
        "stop_loss_pct": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["stance", "stop_loss_pct", "reason"],
    "additionalProperties": False,
}


def ask_claude(data, prob_up, qty, price, equity):
    """Returns Claude's decision as a dict, or None if Claude isn't set up or something went wrong."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("No ANTHROPIC_API_KEY set, so Claude is skipped and the bot keeps the small base amount.")
        return None
    try:
        import anthropic

        recent = data.tail(60)
        table = recent.assign(
            ret_1=(recent["ret_1"] * 100).round(2), ret_5=(recent["ret_5"] * 100).round(2),
            vs_sma20=(recent["sma_ratio_20"] * 100).round(2), vs_sma50=(recent["sma_ratio_50"] * 100).round(2),
            vol20=(recent["volatility_20"] * 100).round(2), volume_x=recent["volume_ratio"].round(2),
            close=recent["close"].round(2),
        )[["close", "ret_1", "ret_5", "vs_sma20", "vs_sma50", "vol20", "volume_x"]]
        table.index = table.index.date
        prompt = CLAUDE_PROMPT.format(
            base_pct=BASE_PCT, base_dollars=equity * BASE_PCT, big_dollars=BIG_DOLLARS,
            min_stop=MIN_STOP_PCT, max_stop=MAX_STOP_PCT, max_loss=MAX_LOSS,
            equity=equity, qty=qty, held_dollars=qty * price, prob_up=prob_up,
            table=table.to_string(),
        )

        client = anthropic.Anthropic()
        response = client.beta.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},  # if Claude declines, Anthropic retries on a fallback model
            output_config={"format": {"type": "json_schema", "schema": DECISION_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
        if response.stop_reason == "refusal":
            print("Claude declined to answer today, so the bot keeps the small base amount.")
            return None
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)
    except Exception as e:
        print(f"Couldn't get a decision from Claude ({e}), so the bot keeps the small base amount.")
        return None


def make_plan(decision, price, equity):
    """Turn Claude's answer into a share count, enforcing the safety limits in code."""
    if decision and decision.get("stance") == "big":
        stop_pct = min(max(float(decision.get("stop_loss_pct") or MAX_STOP_PCT), MIN_STOP_PCT), MAX_STOP_PCT)
        dollars = min(BIG_DOLLARS, MAX_LOSS / stop_pct)
        shares = int(dollars // price)
        stop_price = round(price * (1 - stop_pct), 2)
        return {"decided_by": "claude", "stance": "big", "dollars": shares * price, "shares": shares,
                "stop_pct": stop_pct, "stop_price": stop_price, "max_loss": shares * (price - stop_price),
                "reason": decision.get("reason", "")}
    shares = int(equity * BASE_PCT // price)
    return {"decided_by": "claude" if decision else "fallback", "stance": "base", "dollars": shares * price,
            "shares": shares, "stop_pct": 0, "stop_price": None, "max_loss": 0,
            "reason": (decision or {}).get("reason") or "Claude wasn't available, so the bot kept the small base amount."}


def market_trades_today(clock):
    """True if the market is open now, or opens later today (Alpaca's clock is in New York time)."""
    return clock.is_open or clock.next_open.date() == clock.timestamp.date()


LOG_FILE = "trade_log.csv"


CLAUDE_LOG = "claude_log.csv"


def log_claude(stamp, plan, held):
    """Save Claude's plan and reasoning (the website shows it next to each decision)."""
    new_file = not os.path.exists(CLAUDE_LOG)
    with open(CLAUDE_LOG, "a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["date", "decided_by", "stance", "shares", "stop_price", "max_loss", "reason"])
        w.writerow([stamp, plan["decided_by"], plan["stance"], f"{held:g}",
                    plan["stop_price"] or "", f"{plan['max_loss']:.0f}", " ".join(plan["reason"].split())])


def log_run(stamp, prob_up, action, equity, price):
    """Add one line to the log every time the bot runs."""
    new_file = not os.path.exists(LOG_FILE)
    with open(LOG_FILE, "a") as f:
        if new_file:
            f.write("date,prob_up,action,equity,spy_price\n")
        f.write(f"{stamp},{prob_up:.3f},{action},{equity:.2f},{price:.2f}\n")


def status():
    """Show how the bot is doing compared to just holding SPY."""
    trading = TradingClient(API_KEY, SECRET_KEY, paper=True)
    account = trading.get_account()
    equity = float(account.equity)

    print(f"\n=== Bot status ({datetime.now():%Y-%m-%d %H:%M}) ===")
    print(f"Account value: ${equity:,.2f}")
    print(f"Cash:          ${float(account.cash):,.2f}")

    positions = trading.get_all_positions()
    if positions:
        print("\nOpen positions:")
        for p in positions:
            print(f"  {p.symbol}: {float(p.qty):.4f} shares, worth ${float(p.market_value):,.2f}, "
                  f"profit/loss ${float(p.unrealized_pl):+,.2f} ({float(p.unrealized_plpc):+.2%})")
    else:
        print("\nNo open positions (all cash).")

    if not os.path.exists(LOG_FILE):
        print("\nNo log yet. Run 'python bot.py trade' first.")
        return

    log = pd.read_csv(LOG_FILE)
    first, last = log.iloc[0], log.iloc[-1]
    bot_return = equity / first["equity"] - 1
    spy_return = last["spy_price"] / first["spy_price"] - 1

    print(f"\nSince first run on {first['date']} ({len(log)} runs):")
    print(f"  Bot return:          {bot_return:+.2%}")
    print(f"  SPY buy-and-hold:    {spy_return:+.2%}  (as of last run)")
    print("\nLast 10 runs:")
    print(log.tail(10).to_string(index=False))


if __name__ == "__main__":
    check_keys()
    command = sys.argv[1] if len(sys.argv) > 1 else "backtest"
    if command == "backtest":
        backtest()
    elif command == "trade":
        trade()
    elif command == "status":
        status()
    else:
        print("Usage: python bot.py [backtest|trade|status]")
