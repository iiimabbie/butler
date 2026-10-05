#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE="$ROOT/.data/service"
PID_FILE="$STATE/butler.pid"
READY_FILE="$STATE/butler.ready"
LOG_FILE="$STATE/butler.log"
LOCK_FILE="$STATE/lock"
SCRIPT="$ROOT/scripts/discord-restart.sh"
NODE=${BUTLER_NODE:-node}
WAIT_SECONDS=${BUTLER_SERVICE_TIMEOUT_SECONDS:-60}
umask 077
mkdir -p "$STATE"
chmod 700 "$STATE"
exec 9>"$LOCK_FILE"
flock -x 9

valid_pid() { case ${1:-} in ''|*[!0-9]*) return 1;; esac; [ "$1" -gt 1 ]; }
managed_pid() {
  pid=$1
  valid_pid "$pid" || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\000' '\n' <"/proc/$pid/cmdline" | grep -Fqx "$SCRIPT"
}
read_pid() {
  [ -f "$PID_FILE" ] || return 1
  IFS= read -r pid <"$PID_FILE" || true
  valid_pid "${pid:-}" || return 1
  printf '%s\n' "$pid"
}
running_pid() {
  pid=$(read_pid) || return 1
  if kill -0 "$pid" 2>/dev/null && managed_pid "$pid"; then printf '%s\n' "$pid"; return 0; fi
  return 1
}
unmanaged_process() {
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    proc_pid=${proc##*/}
    [ "$proc_pid" -gt 1 ] 2>/dev/null || continue
    if tr '\000' '\n' <"$proc/cmdline" 2>/dev/null | grep -Fqx "$ROOT/dist/main.js"; then
      printf '%s\n' "$proc_pid"; return 0
    fi
    if tr '\000' '\n' <"$proc/cmdline" 2>/dev/null | grep -Fqx "$SCRIPT"; then
      printf '%s\n' "$proc_pid"; return 0
    fi
    if [ -r "$proc/cwd" ] && [ "$(readlink "$proc/cwd" 2>/dev/null || true)" = "$ROOT" ] && tr '\000' '\n' <"$proc/cmdline" 2>/dev/null | grep -Fqx 'dist/main.js'; then
      printf '%s\n' "$proc_pid"; return 0
    fi
  done
  return 1
}
check_node() {
  node_path=$(command -v "$NODE" 2>/dev/null) || { echo 'Node executable not found; set BUTLER_NODE or PATH' >&2; return 1; }
  [ -x "$node_path" ] || { echo 'Node executable is not executable' >&2; return 1; }
  NODE=$node_path
  version=$("$NODE" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${version%%.*}; rest=${version#*.}; minor=${rest%%.*}
  if [ "$major" -lt 24 ] || { [ "$major" -eq 24 ] && [ "$minor" -lt 17 ]; }; then
    echo "Node.js >=24.17 is required (found $version)" >&2; return 1
  fi
}

start_service() {
  if pid=$(running_pid); then echo "Butler already running (PID $pid)"; return 0; fi
  if pid=$(read_pid); then
    if kill -0 "$pid" 2>/dev/null; then
      echo "Refusing to start: recorded PID $pid is not the managed launcher" >&2; return 1
    fi
    rm -f "$PID_FILE" "$READY_FILE"
  fi
  if pid=$(unmanaged_process); then
    echo "Refusing to start: Butler process $pid is already running unmanaged" >&2; return 1
  fi
  check_node || return 1
  rm -f "$READY_FILE"
  BUTLER_NODE="$NODE" BUTLER_SERVICE_READY_FILE="$READY_FILE" nohup setsid sh "$SCRIPT" </dev/null >>"$LOG_FILE" 2>&1 9>&- &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  elapsed=0
  while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE" "$READY_FILE"
      echo "Butler failed to start; see $LOG_FILE" >&2; return 1
    fi
    if [ -f "$READY_FILE" ]; then
      if managed_pid "$pid"; then echo "Butler ready (PID $pid); log $LOG_FILE"; return 0; fi
      echo 'Butler readiness marker found but launcher PID did not match' >&2; return 1
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  echo "Butler readiness timed out; PID $pid retained for inspection; see $LOG_FILE" >&2
  return 1
}
stop_service() {
  if ! pid=$(read_pid); then
    rm -f "$PID_FILE" "$READY_FILE"
    echo 'Butler is not running'; return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null || ! managed_pid "$pid"; then
    rm -f "$PID_FILE" "$READY_FILE"
    echo 'Butler is not running'; return 0
  fi
  kill -TERM "$pid"
  elapsed=0
  while kill -0 "$pid" 2>/dev/null && managed_pid "$pid" && [ "$elapsed" -lt "$WAIT_SECONDS" ]; do sleep 1; elapsed=$((elapsed + 1)); done
  if kill -0 "$pid" 2>/dev/null && managed_pid "$pid"; then echo "Butler did not stop within ${WAIT_SECONDS}s; see $LOG_FILE" >&2; return 1; fi
  rm -f "$PID_FILE" "$READY_FILE"
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
