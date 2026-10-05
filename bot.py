"""
AI Paper-Trading Bot
--------------------
Uses a machine learning model (Random Forest) to predict whether a stock will
go up tomorrow, then trades on Alpaca's PAPER (fake money) account.

Usage:
    python bot.py backtest   -> test the strategy on past data (no trading)
    python bot.py trade      -> make today's prediction and place a paper trade
    python bot.py status     -> see account value, positions and progress vs SPY
    python bot.py test-text  -> send a test notification to your phone
"""

import os
import sys
from datetime import datetime, timedelta

import pandas as pd
import requests
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier

from alpaca.data.enums import DataFeed
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import GetOrdersRequest, MarketOrderRequest

# ---------------- Settings you can tweak ----------------
SYMBOL = "SPY"          # what to trade (SPY = S&P 500 ETF)
YEARS_OF_DATA = 8       # how much history to learn from
BUY_THRESHOLD = 0.55    # only buy if model is >55% confident of an up day
POSITION_PCT = 0.10     # use 10% of account equity per trade
TRAIN_FRACTION = 0.8    # backtest: train on first 80%, test on last 20%
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
    """Retrain on all data, predict tomorrow, and place a paper trade."""
    trading = TradingClient(API_KEY, SECRET_KEY, paper=True)  # paper=True is hard-coded on purpose

    # Skip weekends and market holidays. Before the opening bell on a trading day is fine:
    # the order waits and fills when the market opens.
    clock = trading.get_clock()
    if not market_trades_today(clock):
        print(f"\n{datetime.now():%Y-%m-%d %H:%M}  The market is closed today. Skipping, no trade.")
        send_text("The stock market is closed today, so the AI is taking the day off. No trade.")
        return

    data = make_features(get_prices(SYMBOL)).dropna(subset=FEATURES)
    train = data.dropna(subset=["next_ret"])
    model = build_model().fit(train[FEATURES], train["target"])

    latest = data.iloc[[-1]]
    prob_up = model.predict_proba(latest[FEATURES])[0, 1]
    print(f"\n{datetime.now():%Y-%m-%d %H:%M}  {SYMBOL}  latest bar: {latest.index[0].date()}")
    print(f"Model says chance of an up day: {prob_up:.1%} (buy threshold {BUY_THRESHOLD:.0%})")

    try:
        qty = float(trading.get_open_position(SYMBOL).qty)
    except Exception:
        qty = 0.0

    equity = float(trading.get_account().equity)

    # Don't place a new order if one is already waiting to fill
    open_orders = trading.get_orders(GetOrdersRequest(status=QueryOrderStatus.OPEN, symbols=[SYMBOL]))
    if open_orders:
        print(f"There's already a pending order for {SYMBOL}. Waiting for it to fill, no new trade.")
        send_text(f"Trading bot update. The model gives {SYMBOL} a {prob_up:.0%} chance of going up. "
                   f"An order is still waiting to fill, so no new trade today.")
        return

    if prob_up > BUY_THRESHOLD and qty == 0:
        dollars = round(equity * POSITION_PCT, 2)
        order = MarketOrderRequest(
            symbol=SYMBOL,
            notional=dollars,
            side=OrderSide.BUY,
            time_in_force=TimeInForce.DAY,
        )
        trading.submit_order(order)
        action = "BUY"
        spoken = f"Bought about {dollars:,.0f} dollars of {SYMBOL}."
        print(f"BUY order placed: ${dollars:,.2f} of {SYMBOL}")
    elif prob_up <= BUY_THRESHOLD and qty > 0:
        trading.close_position(SYMBOL)
        action = "SELL"
        spoken = f"Sold all {SYMBOL} shares and moved to cash."
        print(f"SELL: closed position of {qty} shares")
    else:
        action = "HOLD" if qty > 0 else "CASH"
        spoken = f"No trade today. Still {'holding ' + SYMBOL if qty > 0 else 'in cash'}."
        print(f"No trade needed ({'holding' if qty > 0 else 'staying in cash'}).")

    if not clock.is_open:
        print("The market hasn't opened yet. Any order will fill when it opens.")

    log_run(prob_up, action, equity, float(latest["close"].iloc[0]))
    print(f"Saved to {LOG_FILE}. Run 'python bot.py status' to see progress.")

    log = pd.read_csv(LOG_FILE)
    first = log.iloc[0]
    bot_return = equity / first["equity"] - 1
    spy_return = float(latest["close"].iloc[0]) / first["spy_price"] - 1
    send_text(
        f"The AI gives {SYMBOL} a {prob_up:.0%} chance of going up today. {spoken}\n"
        f"Account: ${equity:,.0f} (fake money)\n"
        f"Score since {str(first['date'])[:10]}: AI {bot_return:+.1%} vs. just holding {SYMBOL} {spy_return:+.1%}"
    )


def market_trades_today(clock):
    """True if the market is open now, or opens later today (Alpaca's clock is in New York time)."""
    return clock.is_open or clock.next_open.date() == clock.timestamp.date()


def send_text(message):
    """Send a notification to your phone through the free ntfy app (if NTFY_TOPIC is set in .env)."""
    topic = os.getenv("NTFY_TOPIC")
    if not topic:
        return  # notifications not set up, skip
    try:
        requests.post(
            f"https://ntfy.sh/{topic}",
            data=message.encode("utf-8"),
            headers={"Title": "AI Trading Bot daily update", "Tags": "chart_with_upwards_trend"},
            timeout=10,
        )
        print("Notification sent to your phone.")
    except Exception as e:
        print(f"Notification failed: {e}")


LOG_FILE = "trade_log.csv"


def log_run(prob_up, action, equity, price):
    """Add one line to the log every time the bot runs."""
    new_file = not os.path.exists(LOG_FILE)
    with open(LOG_FILE, "a") as f:
        if new_file:
            f.write("date,prob_up,action,equity,spy_price\n")
        f.write(f"{datetime.now():%Y-%m-%d %H:%M},{prob_up:.3f},{action},{equity:.2f},{price:.2f}\n")


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
    elif command == "test-text":
        send_text("Test from your AI trading bot. Notifications are working!")
    else:
        print("Usage: python bot.py [backtest|trade|status|test-text]")
