#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:3200}"
for i in $(seq 1 40); do curl -sf "$BASE/api/health" >/dev/null && break; sleep 0.5; done
curl -sf "$BASE/api/health" >/dev/null
curl -sf "$BASE/api/catalog/search?q=protein%20under%201500" >/dev/null
curl -sf "$BASE/api/catalog/search?q=zzzz-no-such-product" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/catalog/search?q=x"); test "$code" = "400"
curl -sf "$BASE/api/dashboard" >/dev/null
curl -sf "$BASE/api/forecast" >/dev/null
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/orders/extract" -H 'content-type: application/json' -d '{"text":"x"}'); test "$code" = "400"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/voice/stt" -H 'content-type: audio/webm' --data-binary ''); test "$code" = "400"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/voice/order" -H 'content-type: audio/webm' --data-binary ''); test "$code" = "400"
echo seed-ok
