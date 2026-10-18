# AI Paper-Trading Bot

A machine learning bot that predicts whether SPY (the S&P 500) will go up tomorrow, trades on a free Alpaca **paper** (fake money) account, and shows the results on a website (GitHub Pages). It runs automatically in the cloud every weekday morning, so no computer is needed.

It only uses paper trading and will refuse to run with real-money keys.

## Set it up from your phone (about 10 minutes)

**1. Get your Alpaca keys**
- Sign up free at https://alpaca.markets (choose **Trading account**).
- Switch to your **Paper Trading** account, then tap **Generate New Keys**.
- Keep the Key (starts with PK) and Secret somewhere handy.

**2. Make your own copy of the bot**
- Sign in to GitHub (free account at github.com).
- On this page, tap **Use this template** > **Create a new repository**.
- Give it a name, choose **Public** (needed for the free website), and tap **Create repository**.

**3. Add your keys to your copy**
In your new repository, go to **Settings > Secrets and variables > Actions > New repository secret** and add these, one at a time:

| Name | Value |
|---|---|
| `ALPACA_API_KEY` | your Alpaca key (starts with PK) |
| `ALPACA_SECRET_KEY` | your Alpaca secret |
| `ANTHROPIC_API_KEY` | (optional) a Claude API key from console.anthropic.com, so Claude makes the daily decision |

**How Claude decides:** each morning Claude reads 60 days of SPY data plus the Random Forest's estimate and picks a
small base position (about 5% of the account) or a big bet (up to $20,000). A big bet gets a stop-loss order so it can
never lose more than $1,000; the code enforces these limits, not Claude. Without `ANTHROPIC_API_KEY` the bot just keeps
the 5% base position. The Claude API is billed per use (roughly a few cents per day for one decision).

**4. Turn on the website**
- Go to **Settings > Pages**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, and **Save**.
- Your dashboard is at `https://<your-username>.github.io/<repo-name>/`.

**5. Turn it on**
- Go to the **Actions** tab. If asked, tap the button to enable workflows.
- Tap **Daily AI trade** > **Run workflow** to test it. A few minutes after it turns green, the website shows the decision.

That's it. It now runs on its own every weekday morning.

## Checking on it
- **Website** (your GitHub Pages link): account value vs. holding SPY, profit/loss, win rate, biggest drop, and every decision with Claude's reasoning.
- **Alpaca app or website**: your positions and order history.
- **trade_log.csv** in your repository: every day's prediction and action.
- **Actions tab**: tap any run to see the full output, including progress vs. buy-and-hold.

## Running it on a computer instead
Chromebook (Linux), Mac or Linux: open a Terminal in this folder, run `bash setup.sh`, then `./run.sh` each day. See the comments in `run.sh` for other commands.

## Good to know
- Never post your keys anywhere. GitHub secrets are encrypted and hidden, even from you after saving.
- In testing this AI did **not** beat just buying and holding SPY. It's a learning project, not a money-maker. Don't use real money with it.
