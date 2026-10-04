#!/usr/bin/env bash
# Nivara dev services in detached screen sessions (logs: /tmp/nivara-<svc>.log).
#   scripts/dev.sh restart server|worker|temporal|all   stop then start, verify the new process owns its port / is RUNNING
#   scripts/dev.sh stop    server|worker|temporal|all
#   scripts/dev.sh status
# Only processes whose cwd is this project AND whose command line matches the service are touched.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

port_of()  { case $1 in server) echo "${PORT:-3000}";; temporal) echo 7233;; *) echo "";; esac; }
pattern()  { case $1 in server) echo 'node .*src/server\.ts';; worker) echo 'node .*src/temporal/worker\.ts';; temporal) echo 'temporal server start-dev';; esac; }
command_of() { case $1 in
  server) echo "env TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS:-localhost:7233} npm start";; # server dials Temporal only when set
  worker) echo "env SUPPLIER_FAIL_FIRST_N=${SUPPLIER_FAIL_FIRST_N:-2} npm run worker";; # 2 = Temporal retry demo
  temporal) echo 'npm run temporal:dev -- --log-level warn';;
esac; }

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }
ours()   { for p in "$@"; do [ "$(cwd_of "$p")" = "$DIR" ] && echo "$p"; done; }
pids()   { ours $(pgrep -f "$(pattern "$1")" || true); }
port_holders() { local port; port=$(port_of "$1"); [ -n "$port" ] && lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true; }
die() { echo "✖ $*" >&2; exit 1; }

stop() {
  local svc=$1 p left
  screen -S "nivara-$svc" -X quit >/dev/null 2>&1 || true
  p=$(pids "$svc" | xargs)
  [ -n "$p" ] && { echo "stopping $svc (pid $p)"; kill -TERM $p 2>/dev/null || true; }
  for _ in $(seq 1 20); do left=$(pids "$svc" | xargs); [ -z "$left" ] && break; sleep 0.5; done
  [ -n "${left:-}" ] && { echo "force-killing $svc (pid $left)"; kill -KILL $left 2>/dev/null || true; sleep 1; }
  left=$(pids "$svc" | xargs); [ -n "$left" ] && die "$svc still running (pid $left)"
  local holders; holders=$(port_holders "$svc" | xargs)
  [ -n "$holders" ] && die "port $(port_of "$svc") still held by pid $holders ($(ps -o command= -p $holders | head -1)) — not ours, not killing it"
  echo "✔ $svc stopped"
}

start() {
  local svc=$1 log="/tmp/nivara-$1.log" new
  : > "$log"
  screen -dmS "nivara-$svc" "${SHELL:-/bin/zsh}" -lc "cd '$DIR' && exec $(command_of "$svc") >> '$log' 2>&1"
  for _ in $(seq 1 60); do
    case $svc in
      server|temporal) new=$(comm -12 <(pids "$svc" | sort) <(port_holders "$svc" | sort) | head -1);;
      worker) new=$(pids "$svc" | head -1); grep -q 'RUNNING' "$log" || new="";;
    esac
    [ -n "$new" ] && break
    sleep 1
  done
  [ -z "$new" ] && { tail -20 "$log" >&2; die "$svc did not come up within 60s (see $log)"; }
  if [ "$svc" = server ]; then curl -fsS "localhost:$(port_of server)/api/health" >/dev/null || die "server pid $new owns the port but /api/health failed"; fi
  echo "✔ $svc running (pid $new$([ -n "$(port_of "$svc")" ] && echo ", owns port $(port_of "$svc")")) — log $log"
}

status() {
  for svc in temporal worker server; do
    local p port; p=$(pids "$svc" | xargs); port=$(port_of "$svc")
    printf '%-9s %-8s pid=%-14s %s %s\n' "$svc" "$([ -n "$p" ] && echo up || echo DOWN)" "${p:--}" \
      "${port:+port $port: $(port_holders "$svc" | xargs | sed 's/^$/free/')}" \
      "$({ screen -ls 2>/dev/null || true; } | grep -q "\.nivara-$svc\b" && echo "screen nivara-$svc" || echo 'no screen')"
  done
}

svcs() { case ${1:-} in all) echo temporal worker server;; server|worker|temporal) echo "$1";; *) die "usage: $0 {restart|stop} {server|worker|temporal|all} | status";; esac; }

case ${1:-} in
  status) status;;
  stop) list=$(svcs "${2:-}"); [ "$list" = "temporal worker server" ] && list="server worker temporal"; for s in $list; do stop "$s"; done;;
  restart)
    list=$(svcs "${2:-}")
    [ "$list" = "temporal worker server" ] && stop_order="server worker temporal" || stop_order=$list
    for s in $stop_order; do stop "$s"; done
    for s in $list; do start "$s"; done;;
  *) svcs "";;
esac
