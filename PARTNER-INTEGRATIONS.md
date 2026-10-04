# Partner integrations — what each one actually does here

Status legend: **verified live** = exercised end-to-end on the dev machine ·
**code complete, key-gated** = implemented against the documented API, fallback verified, live path untested because no key was available ·
**not done** = not built.

| Partner | Product role | Status | Fallback (verified) |
|---|---|---|---|
| **Gemma (open-weight, via Ollama)** | Intent / tool selection, order extraction, open-ended answers, brief summary line | **verified live** (`gemma3:4b`, local Ollama) | keyword router + templated answers |
| **MongoDB** | Source of truth: products, customers, orders, sales, suppliers, preferences, briefs, traces | **verified live** (local MongoDB 9 in Docker). Atlas = same driver, just `MONGODB_URI`; Atlas itself untested | — (required) |
| **Temporal** | Daily brief, low-stock, forecast, supplier-refresh workflows; daily schedule; retries | **verified live** (Temporal CLI 1.9 dev server) | activities run in-process with a retry loop, labelled `direct-fallback` (verified) |
| **Mastra** | `Agent` + `createTool` definitions for all 8 tools | Gemma handles reasoning and structured tool intent, while a validated JSON router provides deterministic tool invocation; Mastra defines the agent and tools. Mastra's native tool-calling route is used only for models that advertise `tools` in Ollama (`gemma3:4b` does not; verified earlier with a `qwen3:8b` stand-in) | keyword router (verified) |
| **TabPFN** | 7-day demand regression per product | **verified live** (TabPFN v2 weights, local CPU, ~18 s / 14 products) | `fallback-moving-average`, labelled in API + UI (verified) |
| **Sentry** | gen_ai agent spans (invoke_agent / chat / execute_tool), error capture, content redacted by default | code complete, DSN-gated. **Real API not tested — needs `SENTRY_DSN`.** Span tree, attributes, redaction and error capture verified offline with the real SDK + a capturing transport (`test/sentry.test.ts`) | local span store + Activity page (verified) |
| **SerpApi** | Google Shopping prices for at-risk products, fetched by the Temporal `supplierRefresh` activity, cached in `supplierPrices`, shown on the dashboard as "Live search" | code complete, key-gated. **Real API not tested — needs `SERPAPI_API_KEY`.** Mock-fetch tests: store, HTTP error, malformed results, no key, blocked supplier | stored DB quotes, labelled "Stored quote" (verified) |
| **Backboard** | Business memory: owner's words saved to Backboard, searched back for supplier decisions | code complete, key-gated, endpoints checked against docs.backboard.io. **Real API not tested — needs `BACKBOARD_API_KEY`.** Mock-fetch tests: save, list, search → changes a supplier decision, outage fallback | Mongo-only, labelled (verified) |
| **ElevenLabs** | Scribe speech-to-text + TTS for spoken answers | code complete, key-gated; "live" only after `GET /v1/user` accepts the key. **Real API not tested — needs `ELEVENLABS_API_KEY`.** Mock-fetch tests: 501 without key, Scribe call with correct file type, 502 on provider failure | browser Web Speech API / speechSynthesis, with a notice on runtime failure |
| **Render** | `render.yaml` blueprint, single web service | prepared, **not deployed** (no credentials) | — |
| **DigitalOcean** | Documented option for hosting Gemma (GPU droplet running Ollama) | docs only — **not claimed** | — |
| **Tiger Data** | — | **skipped**: Mongo already holds the small time series; adding Timescale would be a second database for no product gain | — |

## Details

### Gemma
- Model: `GEMMA_MODEL` (default `gemma3:4b`), served by Ollama, called through its OpenAI-compatible
  `/v1/chat/completions` API with `response_format: json_object` for structured tasks.
- Gemma never writes to the DB and never supplies numbers. Answers to the standard questions (restock, risk,
  pending orders, best sellers, suppliers, memory) are deterministic templates; Gemma writes the answer only for
  open-ended questions, from the template's readable facts (never raw JSON), and the result is rejected if it
  leaks field names (`looksClean`). The daily brief is a deterministic template with a 1–2 sentence Gemma summary
  on top. Every response carries `answerMode: template | template+gemma | gemma`, shown in the UI.
- `gemma3` in Ollama does **not** advertise the `tools` capability, so native tool calling is off. The capability
  check is automatic: a model that advertises `tools` switches to the Mastra native-tools route (not verified
  with any Gemma model here; only `gemma3:4b` and `qwen3:8b` are installed).

### MongoDB
`src/db.ts`. Deterministic CRUD only. The single order write path is `POST /api/orders`, which re-validates
with zod and checks every SKU / customer exists. Delivering an order decrements stock and records the sale,
which feeds the next forecast.

### Temporal
`src/temporal/`. Activities are the same functions the assistant uses (`src/ops.ts`).
- `dailyBriefWorkflow` = lowStockCheck → forecast → supplierRefresh → dailyBrief. Retry policy: 5 attempts,
  exponential backoff. If supplier refresh exhausts retries the brief still completes.
- Schedule `daily-brief` (cron `0 8 * * *`, Asia/Kolkata) created idempotently by the worker.
- Retry demo: `SUPPLIER_FAIL_FIRST_N=2 npm run worker` → attempts 1–2 throw a simulated outage, attempt 3
  succeeds. Verified: worker log shows both failures, the workflow result shows `attempt: 3`.
- `supplierRefresh` is the SerpApi live-price job (see SerpApi below).

### Mastra
Gemma handles reasoning and structured tool intent, while a validated JSON router provides deterministic tool
invocation; Mastra defines the agent and tools. `src/agent.ts` builds one tool table; each tool is registered with
Mastra via `createTool` on an `Agent` whose model is an OpenAI-compatible config pointing at Ollama. Gemma 3 is not
forced into native tool calling: it emits `{"tool","args"}` JSON, validated with zod against the fixed tool enum and
each tool's argument schema, then the same tool function runs. If Gemma's JSON is invalid, a deterministic keyword
router picks the tool. Only a model that advertises `tools` in Ollama uses `agent.generate` with native tool calls.
Every answer reports its `route` and `answerMode`.

### TabPFN
`forecast/forecast.py`, run as a subprocess from Node. Features per (product, day): product code, weekday,
time index, 7-day and 28-day moving means; target = units sold. Rolled forward 7 days recursively.
Output validated in Node (finite, non-negative numbers) before use. TabPFN ≥ 2.5 weights are licence-gated
(`TABPFN_TOKEN` from Prior Labs); without a token the script uses the ungated TabPFN v2 weights, and the
version actually used is shown in the UI ("TabPFN v2").

### Sentry
- `src/instrument.ts` calls `Sentry.init` (only if `SENTRY_DSN`) and is preloaded with `node --import` by
  `npm start` / `npm run worker`, so http/express are auto-instrumented. `Sentry.setupExpressErrorHandler`
  captures 5xx; `traced()` calls `captureException` for failed agent/workflow runs (incl. Temporal activities).
  The server flushes (`Sentry.close`) on SIGTERM.
- Spans (`src/integrations.ts` `span()`, AI Agents conventions): `gen_ai.invoke_agent` per assistant run, with
  `nivara.route`, `gen_ai.tool.name`, `nivara.answer_mode`, `nivara.message_chars`, `gen_ai.request.model`;
  child `gen_ai.chat` (model, `gen_ai.usage.input_tokens/output_tokens`), `gen_ai.execute_tool`, `tool.serpapi`,
  `memory.backboard`, `voice.stt/tts`, `forecast.tabpfn`. Latency = span duration.
- Privacy: prompts, model answers and tool input/output go to Sentry as `[redacted N chars]` unless
  `SENTRY_SEND_CONTENT=1`; `sendDefaultPii: false`; API keys are only in request headers, never in span
  attributes (asserted in `test/sentry.test.ts`). Full content stays in the local Mongo trace (Activity page).
- SDK v11 streams spans (`traceLifecycle: 'stream'`), so hooks are `beforeSendSpan`, not `beforeSendTransaction`.

### SerpApi
- Called only by the Temporal `supplierRefresh` activity (and on demand from the Suppliers page / assistant),
  never on dashboard load. Targets: at-risk products with the largest reorder spend, capped at
  `SUPPLIER_REFRESH_MAX` (default 3) to save quota.
- `engine=google_shopping`, `gl=in`. Each result is zod-validated (title, seller, price > 0, http(s) link) and
  gets a `sourceDomain`; invalid ones are counted as `rejected`. Blocked suppliers are filtered out.
- Latest result per SKU is upserted into `supplierPrices` (`sku, offers, cheapest, sourceDomain, link, checkedAt`).
  The dashboard shows it as "Live search" with the domain link and "checked <time>"; stored DB quotes are labelled
  "Stored quote". If every search fails the activity throws so Temporal retries; nothing is written.
- No key → activity returns `source: 'stored'`, makes no network call; the `SUPPLIER_FAIL_FIRST_N` retry demo
  still runs first.

### Backboard
- Endpoints checked against docs.backboard.io: base `https://app.backboard.io/api`, header `X-API-Key`,
  `POST /assistants` (created once, id kept in `meta`), `POST /assistants/{id}/memories`,
  `GET /assistants/{id}/memories`, `POST /assistants/{id}/memories/search` (`{query, limit}`).
- Saving ("Remember that I don't buy from Supplier C"): the structured rule (`block_supplier`) goes to Mongo
  (source of truth); the owner's words go to Backboard. Only preferences are sent, not the database.
- Retrieval: supplier questions search Backboard for "suppliers the owner does not buy from"; any blocking memory
  found there is merged with the Mongo rules and filters stored quotes and live offers. The answer is labelled
  `mongo + backboard` or `mongo only (Backboard unavailable: …)`. The dashboard uses Mongo rules only, so it
  never waits on Backboard.

### ElevenLabs
- `POST /v1/speech-to-text` (`scribe_v1`) for mic input; the uploaded filename follows the recording's real MIME
  type (`audio.mp4` from Safari, `audio.webm` from Chrome). `POST /v1/text-to-speech/{voice}` for 🔊.
- `/api/health` reports ElevenLabs `live` only when the key is present and `GET /v1/user` accepts it (cached
  10 min); only then does the UI say "Voice: ElevenLabs".
- Provider errors return 502 with a `fallback` hint; the browser shows a small notice and uses Web Speech API /
  speechSynthesis. Voice never blocks the dashboard.
