#!/usr/bin/env bash
# Happy path, bad input, then the same reads against an empty nivara_test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
while [ ! -f "$ROOT/package.json" ]; do ROOT="$(dirname "$ROOT")"; done
cd "$ROOT"
BASE="${BASE:-http://127.0.0.1:3011}"
case "$BASE" in
  *://localhost:3000|*://127.0.0.1:3000|*://0.0.0.0:3000) echo "refusing live port 3000" >&2; exit 1;;
esac
export MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
export MONGODB_DB=nivara_test

mongo() {
  node --input-type=module --eval "$1"
}

for _ in $(seq 1 40); do
  curl -sf -m 2 "$BASE/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf -m 5 "$BASE/api/health" >/dev/null

mongo 'import { client } from "./src/db.ts"; import { seed } from "./src/seed.ts";
if (process.env.MONGODB_DB !== "nivara_test") throw new Error("refusing " + process.env.MONGODB_DB);
await client.connect(); console.log(JSON.stringify(await seed())); await client.close();'

code() {
  curl -sS -m 60 -o /tmp/nivara-api-body -w "%{http_code}" "$@" || echo curl-fail
  echo
}

j() { code -H 'content-type: application/json' "$@"; }

echo "-- happy --"
code "$BASE/api/health"
code "$BASE/api/dashboard"
code "$BASE/api/inventory"
code "$BASE/api/forecast"
code "$BASE/api/orders"
code "$BASE/api/suppliers"
code -G "$BASE/api/suppliers/search" --data-urlencode "q=whey"
j -X POST "$BASE/api/assistant" -d '{"message":"Show my pending orders."}'
j -X POST "$BASE/api/orders/extract" -d '{"text":"Rahul wants 3 chocolate bars and one shaker, deliver tomorrow"}'
j -X POST "$BASE/api/orders" -d '{"customerName":"Rahul Verma","customerId":"C01","items":[{"sku":"P01","quantity":1}],"deliveryDate":"2026-10-06"}' 
ORDER_ID=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const j=JSON.parse(readFileSync("/tmp/nivara-api-body","utf8")); if (!j._id) process.exit(1); process.stdout.write(j._id)')
code -X POST "$BASE/api/orders/$ORDER_ID/deliver"
code "$BASE/api/memory"
j -X POST "$BASE/api/memory" -d '{"text":"Prefer morning deliveries"}'
printf 'abc' > /tmp/nivara-audio.bin
code -X POST "$BASE/api/voice/stt" -H 'content-type: audio/webm' --data-binary @/tmp/nivara-audio.bin
j -X POST "$BASE/api/voice/tts" -d '{"text":"hello"}'
code -X POST "$BASE/api/workflows/lowStockWorkflow/run"
code "$BASE/api/workflows"
code "$BASE/api/traces"
TRACE_ID=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const j=JSON.parse(readFileSync("/tmp/nivara-api-body","utf8")); process.stdout.write(j.traces?.[0]?._id ?? "")')
[ -n "$TRACE_ID" ] && code "$BASE/api/traces/$TRACE_ID"

echo "-- bad input --"
code "$BASE/api/health?x=%"
code "$BASE/api/dashboard?x=%"
code "$BASE/api/inventory?x=%"
code "$BASE/api/forecast?force=no"
code "$BASE/api/orders?x=%"
code "$BASE/api/suppliers?x=%"
code "$BASE/api/suppliers/search?q=a"
j -X POST "$BASE/api/assistant" -d '{}'
j -X POST "$BASE/api/orders/extract" -d '{"text":"ab"}'
j -X POST "$BASE/api/orders" -d '{"customerName":"x","items":[{"sku":"P01","quantity":1.5}]}'
code -X POST "$BASE/api/orders/NO-SUCH-ORDER/deliver"
code "$BASE/api/memory?x=%"
j -X POST "$BASE/api/memory" -d '{"text":"no"}'
code -X POST "$BASE/api/voice/stt" -H 'content-type: audio/webm' --data-binary ''
j -X POST "$BASE/api/voice/tts" -d '{}'
code -X POST "$BASE/api/workflows/nope/run"
code "$BASE/api/workflows?x=%"
code "$BASE/api/traces?x=%"
code "$BASE/api/traces/missing-trace"
j -X POST "$BASE/api/assistant" -d 'not-json'

echo "-- empty db --"
mongo 'import { MongoClient } from "mongodb";
if (process.env.MONGODB_DB !== "nivara_test") throw new Error("refusing " + process.env.MONGODB_DB);
const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); await c.db("nivara_test").dropDatabase(); await c.close();'
code "$BASE/api/health"
code "$BASE/api/dashboard"
code "$BASE/api/inventory"
code "$BASE/api/forecast"
code "$BASE/api/orders"
code "$BASE/api/suppliers"
code -G "$BASE/api/suppliers/search" --data-urlencode "q=whey"
j -X POST "$BASE/api/assistant" -d '{"message":"Show my pending orders."}'
j -X POST "$BASE/api/orders/extract" -d '{"text":"Rahul wants 3 chocolate bars tomorrow"}'
j -X POST "$BASE/api/orders" -d '{"customerName":"Rahul Verma","items":[{"sku":"P01","quantity":1}]}'
code -X POST "$BASE/api/orders/O001/deliver"
code "$BASE/api/memory"
j -X POST "$BASE/api/memory" -d '{"text":"Prefer morning deliveries"}'
code -X POST "$BASE/api/voice/stt" -H 'content-type: audio/webm' --data-binary @/tmp/nivara-audio.bin
j -X POST "$BASE/api/voice/tts" -d '{"text":"hello"}'
code -X POST "$BASE/api/workflows/lowStockWorkflow/run"
code "$BASE/api/workflows"
code "$BASE/api/traces"
code "$BASE/api/traces/missing-trace"
echo done
