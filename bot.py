"""
AI Paper-Trading Bot
--------------------
Uses a machine learning model (Random Forest) to predict whether a stock will
go up tomorrow, then trades on Alpaca's PAPER (fake money) account.

Usage:
    python bot.py backtest   -> test the strategy on past data (no trading)
    python bot.py trade      -> make today's prediction and place a paper trade
    python bot.py status     -> see account value, positions and progress vs SPY
    python bot.py report     -> grade the AI on years of data it never saw (no trading)
"""

import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier, VotingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

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
    "ret_1", "ret_5", "ret_10", "ret_20", "ret_60",
    "sma_ratio_20", "sma_ratio_50", "sma_ratio_200",
    "volatility_20", "vol_regime", "volume_ratio",
    "rsi_14", "macd_hist", "bb_pos", "from_high_252",
]

# Plain-English names for the website and for Claude
FEATURE_NAMES = {
    "ret_1": "Yesterday's move", "ret_5": "Last week's move", "ret_10": "Last 2 weeks' move",
    "ret_20": "Last month's move", "ret_60": "Last 3 months' move",
    "sma_ratio_20": "Price vs 20-day average", "sma_ratio_50": "Price vs 50-day average",
    "sma_ratio_200": "Price vs 200-day average (long-term trend)",
    "volatility_20": "How jumpy the market is", "vol_regime": "Getting calmer or jumpier",
    "volume_ratio": "Trading volume vs normal", "rsi_14": "RSI (overbought / oversold)",
    "macd_hist": "MACD momentum", "bb_pos": "Position in its normal price band",
    "from_high_252": "Distance from the 1-year high",
}

MODEL_NAMES = {"rf": "Random Forest", "gb": "Gradient Boosting", "lr": "Logistic Regression", "ensemble": "Team vote (used)"}


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

    d["ret_60"] = close.pct_change(60)
    d["sma_ratio_200"] = close / close.rolling(200).mean() - 1

    # Risk and activity
    d["volatility_20"] = d["ret_1"].rolling(20).std()
    d["vol_regime"] = d["ret_1"].rolling(5).std() / d["volatility_20"]      # >1 = getting jumpier
    d["volume_ratio"] = d["volume"] / d["volume"].rolling(20).mean()

    # Classic trader indicators
    change = close.diff()
    gain = change.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-change.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    d["rsi_14"] = 1 - 1 / (1 + gain / loss)                                  # 0..1, >0.7 overbought, <0.3 oversold
    macd = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    d["macd_hist"] = (macd - macd.ewm(span=9, adjust=False).mean()) / close
    d["bb_pos"] = (close - close.rolling(20).mean()) / (2 * close.rolling(20).std())   # -1..1 = inside the band
    d["from_high_252"] = close / close.rolling(252, min_periods=60).max() - 1

    # What we're trying to predict: did the price go up the NEXT day?
    d["next_ret"] = close.pct_change().shift(-1)
    d["target"] = (d["next_ret"] > 0).astype(int)
    return d


def build_model():
    """Three different kinds of model vote together; averaging their odds is steadier than any one alone."""
    return VotingClassifier(
        estimators=[
            ("rf", RandomForestClassifier(n_estimators=300, max_depth=5, min_samples_leaf=20,  # shallow = less overfitting
                                          random_state=42, n_jobs=-1)),
            ("gb", HistGradientBoostingClassifier(max_depth=3, learning_rate=0.03, max_iter=150,
                                                  min_samples_leaf=40, l2_regularization=1.0, random_state=42)),
            ("lr", make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=1000))),
        ],
        voting="soft",
    )


def evaluate_model(data, folds=6, test_days=126):
    """Walk-forward test: train only on the past, predict the next ~6 months, repeat.
    This is the honest way to grade a market model, because it never peeks at the future."""
    data = data.dropna(subset=FEATURES + ["next_ret"])
    splitter = TimeSeriesSplit(n_splits=folds, test_size=test_days)
    preds = []
    last_model = None
    for train_idx, test_idx in splitter.split(data):
        train, test = data.iloc[train_idx], data.iloc[test_idx]
        model = build_model().fit(train[FEATURES], train["target"])
        out = pd.DataFrame(index=test.index)
        out["ensemble"] = model.predict_proba(test[FEATURES])[:, 1]
        for name, est in model.named_estimators_.items():
            out[name] = est.predict_proba(test[FEATURES])[:, 1]
        out["target"] = test["target"].values
        out["next_ret"] = test["next_ret"].values
        preds.append(out)
        last_model = model
    p = pd.concat(preds)

    def grade(prob):
        return {"accuracy": round(float(((prob > 0.5) == p["target"]).mean()), 4),
                "brier": round(float(((prob - p["target"]) ** 2).mean()), 4)}

    models = {name: grade(p[name]) for name in ["ensemble", "rf", "gb", "lr"]}
    up_rate = float(p["target"].mean())

    # Calibration: when the model says X%, how often does SPY actually rise?
    bins = [0, 0.45, 0.48, 0.5, 0.52, 0.55, 1]
    labels = ["under 45%", "45-48%", "48-50%", "50-52%", "52-55%", "over 55%"]
    p["bucket"] = pd.cut(p["ensemble"], bins=bins, labels=labels, include_lowest=True)
    calibration = [
        {"bucket": str(b), "days": int(len(g)), "predicted": round(float(g["ensemble"].mean()), 4),
         "actual": round(float(g["target"].mean()), 4)}
        for b, g in p.groupby("bucket", observed=True) if len(g) >= 5
    ]

    # Simple strategy check: be in SPY only on days the team vote leans up
    in_market = p["ensemble"] > 0.5
    strat = (1 + p["next_ret"] * in_market).cumprod()
    hold = (1 + p["next_ret"]).cumprod()
    step = max(1, len(p) // 120)
    curve = [[f"{d:%Y-%m-%d}", round(float(s), 4), round(float(h), 4)]
             for d, s, h in zip(p.index[::step], strat.iloc[::step], hold.iloc[::step])]

    recent = p.tail(60)
    rf = last_model.named_estimators_["rf"]
    importance = sorted(zip(FEATURES, rf.feature_importances_), key=lambda x: -x[1])

    return {
        "made_at": f"{datetime.now():%Y-%m-%d %H:%M}",
        "tested_from": f"{p.index[0]:%Y-%m-%d}", "tested_to": f"{p.index[-1]:%Y-%m-%d}",
        "test_days": int(len(p)), "folds": folds,
        "always_up_accuracy": round(up_rate, 4),
        "models": {k: {**v, "name": MODEL_NAMES[k]} for k, v in models.items()},
        "recent_60_accuracy": round(float(((recent["ensemble"] > 0.5) == recent["target"]).mean()), 4),
        "calibration": calibration,
        "strategy_return": round(float(strat.iloc[-1] - 1), 4),
        "buy_hold_return": round(float(hold.iloc[-1] - 1), 4),
        "days_in_market": round(float(in_market.mean()), 4),
        "curve": curve,
        "importance": [{"feature": f, "name": FEATURE_NAMES[f], "weight": round(float(w), 4)} for f, w in importance],
    }


def print_report(r):
    print(f"\n=== Walk-forward report card ({r['tested_from']} to {r['tested_to']}, {r['test_days']} unseen days) ===")
    print(f"Always guessing 'up' would be right {r['always_up_accuracy']:.1%} of the time. That's the bar to beat.")
    for k, m in r["models"].items():
        print(f"  {m['name']:22s} accuracy {m['accuracy']:.1%}   Brier {m['brier']:.4f} (lower is better)")
    print(f"Last 60 days accuracy: {r['recent_60_accuracy']:.1%}")
    print(f"Lean-up-only strategy: {r['strategy_return']:+.1%} vs buy-and-hold {r['buy_hold_return']:+.1%} "
          f"(in the market {r['days_in_market']:.0%} of days)")
    print("Calibration (model says -> actually happened):")
    for c in r["calibration"]:
        print(f"  {c['bucket']:>9s}: said {c['predicted']:.1%}, really rose {c['actual']:.1%} of {c['days']} days")
    print("Top signals:", ", ".join(i["name"] for i in r["importance"][:5]))


def report():
    """Grade the model on data it never saw and save model_report.json for the website."""
    data = make_features(get_prices(SYMBOL))
    r = evaluate_model(data)
    with open(MODEL_REPORT_FILE, "w") as f:
        json.dump(r, f, indent=1)
    print_report(r)
    return r


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

    importances = pd.Series(model.named_estimators_["rf"].feature_importances_, index=FEATURES).sort_values(ascending=False)
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
        if clock.timestamp.weekday() < 5 and clock.next_open.date() > clock.timestamp.date() and clock.timestamp.hour >= 16:
            print(f"\n{datetime.now():%Y-%m-%d %H:%M}  The market already closed for the day (this run started too late). "
                  "Skipping, no trade.")
        else:
            print(f"\n{datetime.now():%Y-%m-%d %H:%M}  The market is closed today. Skipping, no trade.")
        return

    # The workflow is scheduled several times a day in case GitHub starts it late, so only trade once per day.
    today = f"{clock.timestamp:%Y-%m-%d}"
    if os.path.exists(LOG_FILE) and any(str(d).startswith(today) for d in pd.read_csv(LOG_FILE)["date"]):
        print(f"\nAlready traded today ({today}). Nothing to do.")
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
    votes = {name: round(float(est.predict_proba(latest[FEATURES])[0, 1]), 4)
             for name, est in model.named_estimators_.items()}
    print(f"\n{datetime.now():%Y-%m-%d %H:%M}  {SYMBOL}  latest bar: {latest.index[0].date()}  price ${price:,.2f}")
    print(f"Model team vote says chance of an up day: {prob_up:.1%}  "
          + "  ".join(f"{MODEL_NAMES[k]} {v:.1%}" for k, v in votes.items()))
    write_forecast(data, prob_up)

    # Grade the models on years of data they never saw, so Claude (and you) know how much to trust them.
    try:
        card = evaluate_model(data)
        with open(MODEL_REPORT_FILE, "w") as f:
            json.dump(card, f, indent=1)
        print_report(card)
    except Exception as e:
        print(f"Couldn't build the report card today ({e}).")
        card = None

    qty = current_shares(trading)
    equity = float(trading.get_account().equity)

    context = {"votes": votes, "card": card, "market": market_snapshot(data), "memory": decision_memory()}
    decision = ask_claude(data, prob_up, qty, price, equity, context)
    plan = make_plan(decision, price, equity)
    print(f"Plan ({plan['decided_by']}): {plan['stance']} -> {plan['shares']} shares (~${plan['dollars']:,.0f})"
          + (f", stop-loss at ${plan['stop_price']:,.2f} (max loss ~${plan['max_loss']:,.0f})" if plan["stop_price"] else ""))
    print(f"Why: {plan['reason']}")
    if decision:
        print(f"Claude's read: {decision.get('regime')} market, {decision.get('odds_up_5d'):.0f}% odds SPY is higher in 5 days, "
              f"{decision.get('confidence')} confidence. Watching for: {decision.get('watch_for')}")

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
    write_insights(stamp, decision, plan, prob_up, context)
    print(f"Saved to {LOG_FILE}, {CLAUDE_LOG} and {INSIGHTS_FILE}.")

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
Weigh the model hint by its report card below: if it barely beats "always guess up", treat it as weak evidence.
Learn from your recent calls: if a pattern of reasoning has been wrong lately, say so and adjust.

Fill in every field for a beginner reading the website:
- reason: one or two plain-English sentences explaining today's choice.
- regime: the market's current mood, one of uptrend, downtrend, choppy, high_volatility.
- odds_up_5d: your own estimate (0-100) that SPY is higher five trading days from now.
- confidence: how sure you are about today's call: low, medium or high.
- key_factors: the two or three facts that mattered most today, each under 15 words.
- watch_for: one sentence on what would change your mind or make you switch to a big bet.

Account value: ${equity:,.0f}
Currently holding: {qty:g} shares of SPY (~${held_dollars:,.0f})

Model hint: a team of three machine learning models puts the chance of an up day at {prob_up:.1%}
(individual votes: {votes}).
{card}

Market snapshot:
{market}

Your recent calls and what SPY did by the next run (newest last):
{memory}

Recent daily SPY data, oldest first. ret_1/ret_5 = 1-day/5-day return %, vs_sma20/vs_sma50/vs_sma200 = price vs average %,
vol20 = 20-day volatility %, rsi = 14-day RSI (0-100), volume_x = volume vs its 20-day average:
{table}
"""

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "stance": {"type": "string", "enum": ["base", "big"]},
        "stop_loss_pct": {"type": "number"},
        "reason": {"type": "string"},
        "regime": {"type": "string", "enum": ["uptrend", "downtrend", "choppy", "high_volatility"]},
        "odds_up_5d": {"type": "number"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "key_factors": {"type": "array", "items": {"type": "string"}},
        "watch_for": {"type": "string"},
    },
    "required": ["stance", "stop_loss_pct", "reason", "regime", "odds_up_5d", "confidence", "key_factors", "watch_for"],
    "additionalProperties": False,
}


def market_snapshot(data):
    """A few headline numbers about the market's mood, in plain words."""
    last = data.iloc[-1]
    vol_now = float(last["volatility_20"])
    vol_year = data["volatility_20"].tail(252)
    return {
        "close": round(float(last["close"]), 2),
        "week_change": round(float(last["ret_5"]), 4),
        "month_change": round(float(last["ret_20"]), 4),
        "vs_50d_avg": round(float(last["sma_ratio_50"]), 4),
        "vs_200d_avg": round(float(last["sma_ratio_200"]), 4),
        "from_1y_high": round(float(last["from_high_252"]), 4),
        "rsi": round(float(last["rsi_14"]) * 100, 1),
        "annual_volatility": round(vol_now * (252 ** 0.5), 4),
        "volatility_percentile": round(float((vol_year <= vol_now).mean()), 3),   # 0.9 = jumpier than 90% of the past year
    }


def decision_memory(n=10):
    """Claude's last few calls, paired with what SPY actually did by the following run."""
    if not (os.path.exists(LOG_FILE) and os.path.exists(CLAUDE_LOG)):
        return []
    trades = pd.read_csv(LOG_FILE)
    notes = pd.read_csv(CLAUDE_LOG).set_index("date")
    out = []
    for i in range(max(0, len(trades) - n), len(trades)):
        row = trades.iloc[i]
        nxt = trades.iloc[i + 1]["spy_price"] / row["spy_price"] - 1 if i + 1 < len(trades) else None
        note = notes.loc[row["date"]] if row["date"] in notes.index else None
        if isinstance(note, pd.DataFrame):
            note = note.iloc[-1]
        out.append({
            "date": row["date"], "model_odds": float(row["prob_up"]), "action": row["action"],
            "stance": None if note is None else note["stance"],
            "reason": None if note is None else str(note["reason"])[:220],
            "spy_next": None if nxt is None else round(float(nxt), 4),
        })
    return out


def format_card(card):
    if not card:
        return "(No report card today.)"
    m = card["models"]
    return (f"Report card on {card['test_days']} days the models never saw: team vote right {m['ensemble']['accuracy']:.1%} "
            f"of the time vs {card['always_up_accuracy']:.1%} for always guessing 'up'; last 60 days {card['recent_60_accuracy']:.1%}. "
            f"Top signals: {', '.join(i['name'] for i in card['importance'][:4])}.")


def format_memory(memory):
    if not memory:
        return "(No history yet.)"
    lines = []
    for m in memory:
        after = "not known yet" if m["spy_next"] is None else f"{m['spy_next']:+.2%}"
        lines.append(f"- {m['date']}: model {m['model_odds']:.1%}, you chose {m['stance'] or m['action']}, "
                     f"SPY by next run {after}. You said: {m['reason'] or 'n/a'}")
    return "\n".join(lines)


def ask_claude(data, prob_up, qty, price, equity, context=None):
    """Returns Claude's decision as a dict, or None if Claude isn't set up or something went wrong."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("No ANTHROPIC_API_KEY set, so Claude is skipped and the bot keeps the small base amount.")
        return None
    context = context or {}
    try:
        import anthropic

        recent = data.tail(60)
        table = recent.assign(
            ret_1=(recent["ret_1"] * 100).round(2), ret_5=(recent["ret_5"] * 100).round(2),
            vs_sma20=(recent["sma_ratio_20"] * 100).round(2), vs_sma50=(recent["sma_ratio_50"] * 100).round(2),
            vs_sma200=(recent["sma_ratio_200"] * 100).round(2), vol20=(recent["volatility_20"] * 100).round(2),
            rsi=(recent["rsi_14"] * 100).round(0), volume_x=recent["volume_ratio"].round(2),
            close=recent["close"].round(2),
        )[["close", "ret_1", "ret_5", "vs_sma20", "vs_sma50", "vs_sma200", "vol20", "rsi", "volume_x"]]
        table.index = table.index.date
        votes = context.get("votes") or {}
        prompt = CLAUDE_PROMPT.format(
            base_pct=BASE_PCT, base_dollars=equity * BASE_PCT, big_dollars=BIG_DOLLARS,
            min_stop=MIN_STOP_PCT, max_stop=MAX_STOP_PCT, max_loss=MAX_LOSS,
            equity=equity, qty=qty, held_dollars=qty * price, prob_up=prob_up,
            votes=", ".join(f"{MODEL_NAMES[k]} {v:.1%}" for k, v in votes.items()) or "n/a",
            card=format_card(context.get("card")),
            market=json.dumps(context.get("market") or {}, indent=1),
            memory=format_memory(context.get("memory")),
            table=table.to_string(),
        )

        client = anthropic.Anthropic()
        response = client.beta.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},  # if Claude declines, Anthropic retries on a fallback model
            output_config={"effort": "high",      # think carefully: this is a judgment call with money (fake) on the line
                           "format": {"type": "json_schema", "schema": DECISION_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
        if response.stop_reason == "refusal":
            print("Claude declined to answer today, so the bot keeps the small base amount.")
            return None
        text = next(b.text for b in response.content if b.type == "text")
        decision = json.loads(text)
        decision["odds_up_5d"] = min(max(float(decision.get("odds_up_5d") or 50), 0), 100)
        decision["key_factors"] = [str(k) for k in (decision.get("key_factors") or [])][:3]
        return decision
    except Exception as e:
        print(f"Couldn't get a decision from Claude ({e}), so the bot keeps the small base amount.")
        return None


def write_insights(stamp, decision, plan, prob_up, context):
    """Save today's full briefing (and a rolling history) for the website."""
    history = []
    if os.path.exists(INSIGHTS_FILE):
        try:
            with open(INSIGHTS_FILE) as f:
                history = json.load(f).get("history", [])
        except Exception:
            history = []
    d = decision or {}
    today = {
        "date": stamp, "decided_by": plan["decided_by"], "stance": plan["stance"], "shares": plan["shares"],
        "stop_price": plan["stop_price"], "reason": plan["reason"],
        "regime": d.get("regime"), "odds_up_5d": d.get("odds_up_5d"), "confidence": d.get("confidence"),
        "key_factors": d.get("key_factors", []), "watch_for": d.get("watch_for"),
        "model_prob_up": round(float(prob_up), 4), "votes": context.get("votes"), "market": context.get("market"),
    }
    history = (history + [{k: today[k] for k in ("date", "regime", "odds_up_5d", "confidence", "model_prob_up", "stance")}])[-120:]
    with open(INSIGHTS_FILE, "w") as f:
        json.dump({"latest": today, "history": history}, f, indent=1)


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
FORECAST_FILE = "forecast.json"
MODEL_REPORT_FILE = "model_report.json"
INSIGHTS_FILE = "insights.json"


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


def write_forecast(data, prob_up):
    """Save recent SPY closes and volatility so the website can draw the 'where it might go' range."""
    recent = data["close"].tail(60)
    daily_moves = data["close"].pct_change().dropna().tail(60)
    forecast = {
        "made_at": f"{datetime.now():%Y-%m-%d %H:%M}",
        "symbol": SYMBOL,
        "prob_up": round(float(prob_up), 4),
        "daily_volatility": round(float(daily_moves.std()), 6),      # typical size of one day's move
        "avg_abs_move": round(float(daily_moves.abs().mean()), 6),   # average size, ignoring direction
        "closes": [[f"{d:%Y-%m-%d}", round(float(c), 2)] for d, c in recent.items()],
    }
    with open(FORECAST_FILE, "w") as f:
        json.dump(forecast, f, indent=1)


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
    elif command == "report":
        report()
    else:
        print("Usage: python bot.py [backtest|trade|status|report]")
