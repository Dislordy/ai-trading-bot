# AI Paper-Trading Bot

A machine learning bot that predicts whether SPY (the S&P 500) will go up tomorrow, trades on a free Alpaca **paper** (fake money) account, and sends updates to your phone. It runs automatically in the cloud every weekday morning, so no computer is needed.

It only uses paper trading and will refuse to run with real-money keys.

## Set it up from your phone (about 10 minutes)

**1. Get your Alpaca keys**
- Sign up free at https://alpaca.markets (choose **Trading account**).
- Switch to your **Paper Trading** account, then tap **Generate New Keys**.
- Keep the Key (starts with PK) and Secret somewhere handy.

**2. Set up notifications**
- Install the free **ntfy** app (App Store or Google Play).
- Tap **+** and subscribe to a topic name you make up, like `tradingbot-yourname-` plus random letters and numbers. Treat it like a password.

**3. Make your own copy of the bot**
- Sign in to GitHub (free account at github.com).
- On this page, tap **Use this template** > **Create a new repository**.
- Give it a name, choose **Private**, and tap **Create repository**.

**4. Add your keys to your copy**
In your new repository, go to **Settings > Secrets and variables > Actions > New repository secret** and add these three, one at a time:

| Name | Value |
|---|---|
| `ALPACA_API_KEY` | your Alpaca key (starts with PK) |
| `ALPACA_SECRET_KEY` | your Alpaca secret |
| `NTFY_TOPIC` | your ntfy topic name |

**5. Turn it on**
- Go to the **Actions** tab. If asked, tap the button to enable workflows.
- Tap **Daily AI trade** > **Run workflow** to test it. Your phone should get a notification within a couple of minutes.

That's it. It now runs on its own every weekday morning before the market opens.

## Checking on it
- **Notifications** tell you what the AI decided each day and your account value.
- **Alpaca app or website**: your positions and order history.
- **trade_log.csv** in your repository: every day's prediction and action.
- **Actions tab**: tap any run to see the full output, including progress vs. buy-and-hold.

## Running it on a computer instead
Chromebook (Linux), Mac or Linux: open a Terminal in this folder, run `bash setup.sh`, then `./run.sh` each day. See the comments in `run.sh` for other commands.

## Good to know
- Never post your keys anywhere. GitHub secrets are encrypted and hidden, even from you after saving.
- In testing this AI did **not** beat just buying and holding SPY. It's a learning project, not a money-maker. Don't use real money with it.
