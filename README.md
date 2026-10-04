# Nivara — an AI operations copilot for small businesses

Built first for one real friend's one-person WhatsApp/Instagram shop.

> "What needs my attention in my business today?"

## The problem, and the friend

My friend runs a small fitness-supplements business entirely on WhatsApp and Instagram: protein bars,
whey, shakers, gym gloves. No staff, no ERP. Orders arrive as chat messages ("Rahul wants 3 chocolate bars and
one shaker, deliver tomorrow"), stock lives in his head and a notebook, and he finds out a bestseller ran out when
a customer asks for it. Every morning he needs to know three things: what to deliver, what to restock before it
runs out, and whether he's overpaying a supplier.

## What Nivara does

- **Dashboard**: "N things need your attention" = high-stockout-risk products + overdue / due-soon / undated
  orders + supplier savings worth acting on. A cheaper stored quote counts only if it saves **at least ₹10 per
  unit AND at least 5%** of current cost (`MIN_SUPPLIER_SAVING_RUPEES` / `MIN_SUPPLIER_SAVING_PERCENT` in
  `src/logic.ts`, env-overridable); blocked suppliers and zero/invalid prices are ignored. Smaller savings are
  listed as "below threshold, not counted". Each saving shows as e.g. "Save ₹137/unit (6.4%)".
- **Assistant** (text or voice): "What should I restock?", "Which products are likely to run out?", "Why are you
  recommending this?", "What did I sell the most this week?", "Find cheaper suppliers for this product",
  "What orders are still pending?", "Remember that I don't buy from Supplier X", "Give me today's business brief".
- **Order extraction**: paste a messy chat message → Gemma extracts JSON → zod validation → deterministic matching
  to real products/customers → dates resolved by code → you confirm → saved.
- **Forecast**: TabPFN 7-day demand per product, stockout risk, reorder quantity. Clearly labelled moving-average
  fallback when TabPFN is unavailable.
- **Supplier search**: the daily Temporal workflow fetches SerpApi Google Shopping prices for at-risk products and
  caches them; the dashboard shows them as "Live search" (domain link, checked time) next to "Stored quote"s.
  Blocked suppliers are filtered out. No key → stored quotes only, labelled.
- **Memory**: business preferences ("never buy from Supplier C") stored in Mongo (source of truth for rules),
  saved to and searched back from Backboard when configured, and actually applied (supplier filtering).
- **Workflows**: Temporal runs the daily brief, low-stock check, forecast and supplier refresh on a schedule,
  with retries.
- **Activity / trace**: every answer's model calls, tool calls, latency and errors, locally and in Sentry.

Not built on purpose: auth, payments, WhatsApp integration, mobile app, RBAC.

## Architecture (short)

See [ARCHITECTURE.md](ARCHITECTURE.md). One Node 26 server (Express, TypeScript run natively, no build step),
plain HTML+JS frontend, MongoDB, a Python subprocess for TabPFN, and a Temporal worker.

**Gemma does language, code does facts.** Gemma picks tools, extracts orders, answers open-ended questions and
writes the brief's summary line. DB writes, validation, stock maths, stockout rules, date resolution and workflow
state are deterministic code with tests. Standard questions (restock, why at risk, pending orders, best sellers,
suppliers, memory) are answered by deterministic templates; each response says which (`answerMode`:
`template`, `template+gemma`, `gemma`) and the UI shows it with the source data.

## Setup

Prereqs: Node ≥ 24 (developed on 26), Docker (for local Mongo) or an Atlas URI, [Ollama](https://ollama.com),
optionally `uv` (TabPFN) and the Temporal CLI (`brew install temporal`).

```bash
cd nivara
npm install
cp .env.example .env              # all keys optional
npm run db                        # local MongoDB in Docker (skip if MONGODB_URI points at Atlas)
ollama pull gemma3:4b && ollama serve   # serve may already be running
npm run seed                      # OFF India + Open Prices + Trends proxy demand → Atlas + Tiger
npm run seed:demo                 # old synthetic demo catalogue
npm start                         # http://localhost:3000

# optional, separate terminals:
npm run forecast:setup            # TabPFN in forecast/.venv (python 3.11, pulls torch); v2 weights download on
                                  # first run; set TABPFN_TOKEN (Prior Labs licence) to use the newest weights
npm run forecast:publish          # run TabPFN here, store predictions in Mongo (forecastRuns) for a Python-less host
npm run temporal:dev              # Temporal dev server + UI on :8233
SUPPLIER_FAIL_FIRST_N=2 npm run worker   # worker + daily schedule; supplier activity fails twice to show retries

npm test                          # logic, answer formatting, partner paths (mocked fetch, uses Mongo db nivara_test), Sentry offline
python3 forecast/test_forecast.py # forecast feature/recursion test (needs numpy; use forecast/.venv/bin/python)
```

### Running the services (detached `screen` sessions)

Processes started from a short-lived shell die with it, and an old server can keep holding port 3000. Use:

```bash
npm run services -- status                 # pid, port owner, screen session per service
npm run services -- restart all            # stop server → worker → temporal, start temporal → worker → server
npm run services -- restart server         # or worker / temporal
npm run services -- stop all
```

`scripts/dev.sh` only touches processes whose cwd is this project and whose command line is that service
(server: `node … src/server.ts`, worker: `node … src/temporal/worker.ts`, temporal: `temporal server start-dev`).
It sends SIGTERM, then SIGKILL after 10 s, refuses to continue if the port is still held by someone else, starts
the service in `screen` (logs `/tmp/nivara-<svc>.log`), and fails loudly unless the new PID owns the port
(server also passes `/api/health`) or the worker log shows `RUNNING`. The worker starts with
`SUPPLIER_FAIL_FIRST_N=2` (retry demo) unless you set it.

## Deploy to Render

`render.yaml` is a Blueprint for one **free** web service (Singapore, Node 24): `npm ci`, `npm start`, health check
`/api/health`. `npm start` binds `process.env.PORT`; `src/server.ts` exports `app` and only listens when run as the entry.

1. Render → **New → Blueprint** → pick this repo/branch.
2. Fill the `sync: false` vars: `MONGODB_URI` (Atlas; allow `0.0.0.0/0` in Atlas Network Access, free Render has no
   static IP) and `GEMINI_API_KEY` (Google AI Studio). The blueprint already sets `LLM_PROVIDER=gemini`,
   `GEMINI_MODEL=gemma-4-26b-a4b-it` (alt `gemma-4-31b-it`), `MONGODB_DB=nivara`, `FORECAST_MODE=fallback`.
3. Optional: `SERPAPI_API_KEY`, `BACKBOARD_API_KEY`, `ELEVENLABS_API_KEY`, `SENTRY_DSN`; leave `TEMPORAL_*` and
   `OLLAMA_*` empty.

An empty database is seeded with demo data on first boot. Without a Gemini key, Temporal, or TabPFN the app uses
its labelled fallbacks (keyword router + templated answers, in-process workflows, moving-average forecast). No auth.

## Environment variables

| Var | Needed for | Without it |
|---|---|---|
| `MONGODB_URI` | data (default `mongodb://localhost:27017`) | health reports Mongo down; routes that read the DB fail |
| `LLM_PROVIDER` | `ollama` (default) or `gemini` | — |
| `OLLAMA_BASE_URL`, `GEMMA_MODEL` | Gemma via Ollama (default local `gemma3:4b`) | keyword router + templated answers; order extraction returns 503 |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemma via Google AI Studio (`gemma-4-26b-a4b-it`) + `gemini-embedding-001` for hybrid catalog search | keyword router / FTS-only search |
| `TIGER_DATABASE_URL` | Timescale hypertables + pgvector hybrid `searchCatalog` | Mongo sales + keyword catalog search |
| `SERPAPI_API_KEY` | live supplier prices (Temporal refresh, `SUPPLIER_REFRESH_MAX` products per run, default 5) | stored quotes, labelled |
| `BACKBOARD_API_KEY` | memory saved/searched in Backboard | Mongo only, labelled |
| `ELEVENLABS_API_KEY` | Scribe STT (voice notes → order draft) + TTS | browser Web Speech API |
| `SENTRY_DSN` (`SENTRY_SEND_CONTENT=1` to include prompts/answers) | Sentry agent traces + errors | local traces only |
| `MIN_SUPPLIER_SAVING_RUPEES` / `MIN_SUPPLIER_SAVING_PERCENT` | attention threshold (default ₹10 and 5%) | defaults |
| `TEMPORAL_ADDRESS` (+`TEMPORAL_API_KEY` for Cloud) | Temporal | workflows run in-process, labelled `direct-fallback` |
| `FORECAST_MODE=fallback` | skip TabPFN | — |
| `FORECAST_RUN_MAX_AGE_HOURS` | how long a published TabPFN run (`npm run forecast:publish`) is used on hosts without Python (default 168) | moving average |

Full list in [.env.example](.env.example). `GET /api/health` reports each integration as `live` or `fallback`.

## Partner tech

See [PARTNER-INTEGRATIONS.md](PARTNER-INTEGRATIONS.md) for the role of each partner, how it was verified, and
what is fallback-only.

## Open-source AI: why Gemma

- **Model**: Gemma 3 4B instruction-tuned (`gemma3:4b`), configurable via `GEMMA_MODEL`.
- **Where it runs**: locally through Ollama on the shop owner's laptop (Apple Silicon, 16 GB RAM is enough), or on
  any OpenAI-compatible host (e.g. Ollama on a DigitalOcean GPU droplet) via `OLLAMA_BASE_URL`.
- **Tasks**: tool selection (JSON), order extraction (JSON), open-ended answers, the morning brief's summary line.
- **Why**: customer names, phone-chat orders and margins are exactly the data a tiny business shouldn't ship to a
  closed API by default. An open-weight model runs on hardware he already owns, costs nothing per message, keeps
  working when a vendor changes pricing, and can be swapped or fine-tuned later.
- **Failure behaviour**: Gemma output is never trusted blindly. Tool choices and extractions are zod-validated;
  invalid extraction JSON gets one corrective retry then a 422; routing failures fall to a deterministic keyword
  router; if Gemma is unreachable the assistant still answers from tool data with templates, and the UI says
  which route was used. Gemma never writes to the DB.
- **Swapping models**: `GEMMA_MODEL=gemma3:12b` (better reasoning) or `gemma4:e4b` (native tool calling in
  Ollama, which switches the assistant onto the Mastra native-tools route automatically). Any OpenAI-compatible
  server works.

## Verification status (dev machine: macOS, Apple Silicon, 16 GB, 2026-10-04)

Actually run end-to-end:
- MongoDB (local Docker), seed, all dashboard/inventory/orders/forecast/suppliers APIs and pages.
- **Gemma 3 4B via Ollama**: all 8 assistant questions routed correctly by the Gemma JSON router
  (10–30 s each on CPU/Metal); order extraction for English and Hinglish messages
  ("neha ko 2 pb bar aur ek creatine bhejna hai friday tak" → Neha Sharma, 2× PB bar, 1× creatine, Friday's date).
- **TabPFN v2** (local, CPU): 14 products forecast in ~18 s through the API, labelled `method: tabpfn`. Real catalogue:
  212 products in 317 s (4 chunks of 50 + 12, Apple M5 CPU, tabpfn 9.1.0) published to Atlas with `npm run forecast:publish`;
  the Render deploy serves it as `method: tabpfn`, `precomputed`.
- **Temporal** (CLI dev server): daily-brief workflow with Gemma + TabPFN; supplier activity failed attempts 1–2
  (simulated) and succeeded on attempt 3; schedule `daily-brief` registered (next run 08:00 IST).
- **Mastra native tool calling**: verified only with `qwen3:8b` as a stand-in (Gemma 3 lacks the tools capability
  in Ollama). With Gemma 3 the Mastra-registered tools are selected through the JSON router.
- **Sentry**: span tree (invoke_agent → chat / execute_tool), route/tool/answer-mode/token attributes, content
  redaction, absence of secrets and error capture verified offline with the real SDK (`test/sentry.test.ts`);
  delivery to a real Sentry project not verified (no DSN).
- **Answer quality**: the 5 dashboard questions answered through Gemma routing with `answerMode: template`
  (brief: `template+gemma`); an open-ended question answered by Gemma (`answerMode: gemma`).
- **Attention**: 12 items on the seeded data (5 high-risk products, 3 orders, 4 supplier savings ≥ ₹10 and ≥ 5%),
  down from 16 before the threshold.
- SerpApi / Backboard / ElevenLabs code paths: tested with mocked `fetch` in `test/partners.test.ts`.
- Fallbacks: no Gemma → keyword router + templates; no TabPFN → labelled moving average; no Temporal →
  `direct-fallback`; no SerpApi/Backboard/ElevenLabs keys → labelled fallbacks.

Not verified (no keys): real SerpApi results, real Backboard API calls, real ElevenLabs STT/TTS, Sentry ingestion,
Render deploy, Atlas (same driver; only the URI differs). Browser voice (Web Speech API) needs a real mic and
wasn't exercised by automation.

## Data

See [DATA.md](DATA.md). `npm run seed` loads Open Food Facts India catalogue, Open Prices (INR), and
Google Trends→proxy weekly demand into Atlas (ops) + Tiger (analytics). Owner CSV/WhatsApp: `npm run import:orders`.

## Limitations

- Seeded demand is a search-interest proxy (not POS sales); import the owner's orders when available.
- 4B model: decent JSON, occasionally weak routing (hence validation + fallbacks). Its free-text answers mixed up
  stock figures and leaked field names, so the standard questions are now answered by templates.
- Supplier web prices are retail listings; pack sizes aren't normalised against wholesale unit cost.
- Product matching is token overlap, fine for ~15 SKUs, not for hundreds.
- TabPFN on CPU takes tens of seconds per forecast; results are cached per day. Render has no Python, so the live
  site uses a TabPFN run published from a laptop (`npm run forecast:publish`) until it is older than 7 days.
- Single-tenant, no auth: run it locally or behind a private URL.

## Future work

- WhatsApp Business API ingestion of order messages (the extraction pipeline is ready for it).
- Purchase orders: one click from "reorder 51" to a supplier message.
- Pack-size normalisation for supplier comparisons; supplier lead-time learning.
- Gemma 4 with native tool calling as the default once it fits the target hardware comfortably.
