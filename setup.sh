#!/bin/bash
# One-time setup for the AI Trading Bot (Chromebook Linux, Ubuntu/Debian, or Mac)
set -e
cd "$(dirname "$0")"

echo "=== AI Trading Bot setup ==="

# Chromebook / Debian / Ubuntu need these system tools
if command -v apt >/dev/null 2>&1; then
  echo "Installing Python tools (you may be asked for your password)..."
  sudo apt update -qq && sudo apt install -y python3-pip python3-venv nano
fi

echo "Creating the bot's Python environment..."
python3 -m venv venv
source venv/bin/activate
pip install -q -r requirements.txt

if [ -f .env ]; then
  echo ".env already exists, keeping your current keys."
else
  echo ""
  echo "Get your keys from app.alpaca.markets (Paper Trading account > Generate New Keys)."
  read -p "Paste your Alpaca PAPER API key (starts with PK): " KEY
  read -p "Paste your Alpaca secret key: " SECRET
  cat > .env <<ENV
ALPACA_API_KEY=$KEY
ALPACA_SECRET_KEY=$SECRET
ENV
  echo "Saved your keys to .env"
fi

echo ""
echo "Setup done! Run ./run.sh backtest to test the AI, or ./run.sh to trade."
