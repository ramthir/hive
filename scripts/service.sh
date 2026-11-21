#!/usr/bin/env bash
# Run Hive in the background: scripts/service.sh start|stop|restart|status
# No systemd needed. The pid and the log live in ~/.local/state/hive/. Settings come from the environment and .env
# (NOTES_DIR, PORT, HOST, ...), as for `python main.py`; NOTES_DIR defaults to ~/Workspace/notes.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="${HIVE_STATE_DIR:-$HOME/.local/state/hive}"
PIDFILE="$STATE/hive.pid"
LOG="$STATE/hive.log"
mkdir -p "$STATE"

# True if `$1` is a `python main.py` whose working directory is this one.
is_hive() {
  [[ "$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)" == *"python main.py"* ]] && [[ "$(readlink "/proc/$1/cwd" 2>/dev/null)" == "$PWD" ]]
}

# The pid of a running Hive: the pidfile's, or (a Hive started by hand) a `main.py` running from this directory.
running_pid() {
  local pid=""
  [[ -f "$PIDFILE" ]] && pid="$(cat "$PIDFILE")"
  # A pidfile left by an earlier container or boot can name a pid that is now another process: check it is `main.py` here.
  if [[ -n "$pid" ]] && is_hive "$pid"; then echo "$pid"; return 0; fi
  for pid in $(pgrep -f '^\.venv/bin/python main\.py$' || true); do
    is_hive "$pid" && { echo "$pid"; return 0; }
  done
  return 1
}

stop() {
  local pid
  pid="$(running_pid)" || { echo "not running"; rm -f "$PIDFILE"; return 0; }
  kill "$pid"
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then echo "pid $pid did not stop; kill -9 it by hand" >&2; return 1; fi
  rm -f "$PIDFILE"
  echo "stopped ($pid)"
}

start() {
  if pid="$(running_pid)"; then echo "already running ($pid)"; return 0; fi
  NOTES_DIR="${NOTES_DIR:-$HOME/Workspace/notes}" setsid nohup .venv/bin/python main.py >>"$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  local port="${PORT:-80}"
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then echo "started ($(cat "$PIDFILE")), port $port, log $LOG"; return 0; fi
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
    sleep 0.25
  done
  echo "did not come up; last log lines:" >&2; tail -5 "$LOG" >&2; return 1
}

status() {
  local pid
  if pid="$(running_pid)"; then echo "running ($pid)"; curl -fsS "http://127.0.0.1:${PORT:-80}/api/health" || true; echo; else echo "not running"; return 1; fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
