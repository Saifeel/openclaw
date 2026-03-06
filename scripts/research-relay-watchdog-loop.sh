#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHDOG_SCRIPT="$ROOT_DIR/scripts/research-relay-watchdog.sh"
STATE_DIR="${STATE_DIR:-$HOME/.openclaw/relay-watchdog}"
PID_FILE="$STATE_DIR/watchdog-loop.pid"
LOOP_LOG="$STATE_DIR/watchdog-loop.log"
INTERVAL_SEC="${INTERVAL_SEC:-120}"

mkdir -p "$STATE_DIR"

if [[ "${1:-}" == "stop" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
      echo "stopped watchdog loop pid=$pid"
    fi
    rm -f "$PID_FILE"
  else
    echo "watchdog loop not running"
  fi
  exit 0
fi

if [[ "${1:-}" == "start" || "${1:-}" == "" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "watchdog loop already running pid=$pid"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi

  nohup bash -lc "
    while true; do
      \"$WATCHDOG_SCRIPT\" >> \"$LOOP_LOG\" 2>&1 || true
      sleep \"$INTERVAL_SEC\"
    done
  " >/dev/null 2>&1 &
  new_pid="$!"
  printf '%s\n' "$new_pid" > "$PID_FILE"
  echo "started watchdog loop pid=$new_pid interval=${INTERVAL_SEC}s"
  exit 0
fi

echo "usage: $0 [start|stop]"
exit 1
