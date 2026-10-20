#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE="$ROOT/.data/service"
PID_FILE="$STATE/butler.pid"
LIVENESS_FILE="$STATE/butler.liveness"
LOG_FILE="$STATE/butler.log"
SCRIPT="$ROOT/scripts/discord-restart.sh"
NODE=${BUTLER_NODE:-$(command -v node)}
WAIT_SECONDS=${BUTLER_SERVICE_TIMEOUT_SECONDS:-60}
umask 077
mkdir -p "$STATE"

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE")
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

start_service() {
  if pid=$(running_pid); then echo "Butler already running (PID $pid)"; return 0; fi
  rm -f "$PID_FILE" "$LIVENESS_FILE"
  BUTLER_NODE="$NODE" BUTLER_SERVICE_LIVENESS_FILE="$LIVENESS_FILE" nohup setsid sh "$SCRIPT" </dev/null >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  elapsed=0
  while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE" "$LIVENESS_FILE"
      echo "Butler failed to start; see $LOG_FILE" >&2; return 1
    fi
    if [ -f "$LIVENESS_FILE" ]; then echo "Butler ready (PID $pid); log $LOG_FILE"; return 0; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  echo "Butler readiness timed out; see $LOG_FILE" >&2
  return 1
}

stop_service() {
  if ! pid=$(running_pid); then
    rm -f "$PID_FILE" "$LIVENESS_FILE"
    echo 'Butler is not running'; return 0
  fi
  kill -TERM "$pid"
  elapsed=0
  while kill -0 "$pid" 2>/dev/null && [ "$elapsed" -lt "$WAIT_SECONDS" ]; do sleep 1; elapsed=$((elapsed + 1)); done
  if kill -0 "$pid" 2>/dev/null; then echo "Butler did not stop within ${WAIT_SECONDS}s; see $LOG_FILE" >&2; return 1; fi
  rm -f "$PID_FILE" "$LIVENESS_FILE"
  echo 'Butler stopped'
}

case ${1:-} in
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service && start_service ;;
  status)
    if pid=$(running_pid); then
      printf 'Butler running (PID %s)\nLog: %s\n' "$pid" "$LOG_FILE"
    else
      printf 'Butler stopped\nLog: %s\n' "$LOG_FILE"
      exit 1
    fi
    ;;
  *) echo 'Usage: scripts/butler-service.sh {start|stop|restart|status}' >&2; exit 2;;
esac
