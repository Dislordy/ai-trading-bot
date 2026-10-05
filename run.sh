#!/bin/bash
# Daily use:  ./run.sh          -> trade + show status
#             ./run.sh backtest -> test the strategy on past data
#             ./run.sh status   -> show progress
#             ./run.sh test     -> send a test notification to your phone
cd "$(dirname "$0")"
source venv/bin/activate
case "$1" in
  backtest) python bot.py backtest ;;
  status)   python bot.py status ;;
  test)     python bot.py test-text ;;
  *)        python bot.py trade && python bot.py status ;;
esac
