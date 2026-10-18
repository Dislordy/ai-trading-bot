#!/bin/bash
# Daily use:  ./run.sh          -> trade + show status
#             ./run.sh backtest -> test the strategy on past data
#             ./run.sh status   -> show progress
cd "$(dirname "$0")"
source venv/bin/activate
case "$1" in
  backtest) python bot.py backtest ;;
  status)   python bot.py status ;;
  *)        python bot.py trade && python bot.py status ;;
esac
