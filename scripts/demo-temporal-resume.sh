#!/usr/bin/env bash
# Kill the Temporal worker mid dailyBriefWorkflow, restart it, show the workflow resume.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
export TEMPORAL_ADDRESS="$ADDRESS"

if ! curl -sf "http://127.0.0.1:8233" >/dev/null 2>&1 && ! nc -z 127.0.0.1 7233 2>/dev/null; then
  echo "Start Temporal first: npm run temporal:dev"
  exit 1
fi

echo "==> starting worker"
pkill -f 'src/temporal/worker.ts' 2>/dev/null || true
npm run worker > /tmp/nivara-temporal-resume-worker.log 2>&1 &
WORKER_PID=$!
sleep 3

echo "==> starting dailyBriefWorkflow"
WF_ID="dailyBriefWorkflow-resume-demo-$(date +%s)"
# Use temporal CLI if present; else hit the API (in-process won't prove resume — needs worker)
if command -v temporal >/dev/null; then
  temporal workflow start --address "$ADDRESS" --task-queue nivara --type dailyBriefWorkflow --workflow-id "$WF_ID" >/tmp/nivara-wf-start.txt
else
  echo "temporal CLI missing; POST /api/workflows/dailyBriefWorkflow/run instead (needs server + TEMPORAL_ADDRESS)"
  curl -sS -X POST "http://127.0.0.1:${PORT:-3000}/api/workflows/dailyBriefWorkflow/run" | head -c 400
  echo
  kill "$WORKER_PID" 2>/dev/null || true
  exit 0
fi

echo "==> sleeping 2s then killing worker PID $WORKER_PID (mid-run)"
sleep 2
kill -9 "$WORKER_PID" 2>/dev/null || true
sleep 1

echo "==> restarting worker — Temporal should resume the workflow"
npm run worker > /tmp/nivara-temporal-resume-worker.log 2>&1 &
WORKER_PID=$!
sleep 8

echo "==> workflow describe"
temporal workflow describe --address "$ADDRESS" --workflow-id "$WF_ID" || true
echo "==> worker log (tail)"
tail -n 40 /tmp/nivara-temporal-resume-worker.log || true
echo "Done. Leave the worker running or: kill $WORKER_PID"
