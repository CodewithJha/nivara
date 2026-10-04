#!/usr/bin/env bash
# App under test. Always nivara_test, never the live nivara database. Does not load .env.
# Record with node itself, not this bash file: macOS SIP strips Keploy's shim from shells.
set -euo pipefail
cd "$(dirname "$0")/.."
export MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
export MONGODB_DB=nivara_test
export PORT="${PORT:-3011}"
export FORECAST_MODE=fallback
export SUPPLIER_FAIL_FIRST_N=0
export LOG_LEVEL=silent
export TEMPORAL_ADDRESS=127.0.0.1:9
export SERPAPI_API_KEY=test-serp
export BACKBOARD_API_KEY=test-bb
export ELEVENLABS_API_KEY=test-el
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export BUSINESS_TZ=Asia/Kolkata
export SENTRY_DSN=
unset BACKBOARD_ASSISTANT_ID OLLAMA_API_KEY || true
exec node --import ./test/mock-externals.mjs src/server.ts
