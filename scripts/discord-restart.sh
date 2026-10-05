#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=${BUTLER_NODE:-node}
READY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/butler-restart.XXXXXX")
READY_FILE="$READY_DIR/ready"
child=
signal_status=0

forward_signal() {
  signal_status=$1
  if [ -n "$child" ]; then kill -"$2" "$child" 2>/dev/null || true; fi
}
trap 'forward_signal 130 INT' INT
trap 'forward_signal 143 TERM' TERM
trap 'forward_signal 129 HUP' HUP
trap 'rm -rf "$READY_DIR"' EXIT

wait_child() {
  while :; do
    if wait "$child"; then result=0; else result=$?; fi
    if [ "$signal_status" -eq 0 ] || ! kill -0 "$child" 2>/dev/null; then return "$result"; fi
  done
}

while :; do
  rm -f "$READY_FILE"
  BUTLER_RESTART_READY_FILE="$READY_FILE" "$NODE" --network-family-autoselection-attempt-timeout=2000 "$ROOT/dist/main.js" &
  child=$!
  elapsed=0
  timeout=${BUTLER_READY_TIMEOUT_SECONDS:-60}
  while [ ! -f "$READY_FILE" ] && kill -0 "$child" 2>/dev/null && [ "$elapsed" -lt "$timeout" ] && [ "$signal_status" -eq 0 ]; do
    sleep 1 || true
    elapsed=$((elapsed + 1))
  done

  if [ "$signal_status" -ne 0 ]; then
    wait_child || true
    child=
    exit "$signal_status"
  fi

  if [ ! -f "$READY_FILE" ]; then
    if [ "$elapsed" -ge "$timeout" ] && kill -0 "$child" 2>/dev/null; then
      kill -TERM "$child" 2>/dev/null || true
      wait_child || true
      child=
      echo "Butler Discord readiness timed out" >&2
      exit 1
    fi
    if wait_child; then status=0; else status=$?; fi
    child=
    echo "Butler process exited before readiness (exit $status)" >&2
    exit "$status"
  fi

  if wait_child; then status=0; else status=$?; fi
  child=
  if [ "$signal_status" -ne 0 ]; then exit "$signal_status"; fi
  if [ "$status" -eq 75 ]; then continue; fi
  exit "$status"
done
