#!/bin/sh
# A row cut to the pane's width stays on one line, so the board does not jump as it is redrawn
while true; do
  clear
  bun "$(dirname "$0")/board.ts" "$@" | cut -c1-"$(tput cols)"
  sleep 1
done
