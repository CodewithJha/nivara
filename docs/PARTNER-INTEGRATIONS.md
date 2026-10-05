# Partner integrations

What each partner does in Nivara, where the code is, what happens without it, and how it was checked.
"Checked live" means on https://nivara-x9iv.onrender.com on 5 Oct 2026, with the result confirmed in Atlas or
Tiger directly, not only in the page.

| Partner | Status on Render | Without it |
|---|---|---|
| Gemma | Live (`gemma-4-26b-a4b-it`, Google AI Studio) | keyword routing and template answers; order reading off |
| MongoDB Atlas | Live | required |
| Tiger Data | Live | MongoDB sales, keyword search |
| TabPFN | Live, stored run from 4 Oct | labelled 7-day average |
| ElevenLabs | Live | voice notes off; browser speech on Ask |
| SerpApi | Live | stored quotes only |
| Backboard | Live | rules in MongoDB only |
| Sentry | Live | local traces only (Activity page) |
| Render | Live (hosting) | n/a |
| Keploy | used in testing | n/a |
| Temporal | Standby on Render; verified locally | jobs run in the app, 08:00 brief included |
| Mastra | Standby | Gemma picks tools through a validated JSON router |

## Gemma
- **Code:** `src/integrations.ts` (`gemma`, `llmModel`), `src/agent.ts`.
- **Live:** Gemma 4 `gemma-4-26b-a4b-it` through Google AI Studio (`LLM_PROVIDER=gemini`), since a free Render
  instance cannot run a model. Locally: Gemma 3 `gemma3:4b` in Ollama, which most of the app was built against.
- **Tasks:** reads orders out of pasted messages and voice-note transcripts (JSON: customer, items, delivery words),
  picks the tool for a question, writes open-ended answers from readable facts, and writes the brief's summary line.
- **Guards:** every JSON reply is validated with zod; a bad extraction gets one corrective retry, then an error.
  Products and customers are matched by code against the database, and dates are resolved by code (कल, आज, परसों,
  kal, parson, weekdays). Answers that leak field names are dropped for the template answer. Gemma never writes.
- **Checked live:** a pasted Hinglish message and an uploaded voice note both drafted Rahul Verma, 2 × MB biozyme
  whey, ₹5,198, delivery 6 Oct; Health names the model.

## MongoDB Atlas
- **Code:** `src/db.ts`, `src/ops.ts`, `src/server.ts`.
- **Holds:** products (212), customers, orders, sales, suppliers and quotes, rules, briefs, forecast runs,
  online prices, traces. The only order write path is `POST /api/orders`, which re-validates and checks that every
  product and customer exists. Delivering an order takes units off stock and records the sale.
- **Checked live:** confirmed orders appeared in Atlas with short numbers; Mark delivered moved MB biozyme whey
  stock 21 → 19 → 17 and added the sales.

## Tiger Data
- **Code:** `src/tiger.ts`, `src/sync.ts`.
- **Holds:** `sales_daily` hypertable (the 60-day history the forecast reads), continuous aggregates
  `sales_demand_7d` and `sales_demand_28d`, `order_sales` (one row per delivered order line), and `catalog_items`
  with `tsvector` and `vector(768)` columns.
- **Sync:** an Atlas change stream on `orders` sends each delivered order to `order_sales`, keyed by order and
  product, and adds the units to `sales_daily` on the shop's day (Asia/Kolkata). `npm run sync:tiger` backfills.
- **Search:** the `search_catalog` tool and `GET /api/catalog/search` combine full-text search with
  `gemini-embedding-001` vectors and read limits like "under 3000".
- **Checked live:** each delivered test order produced an `order_sales` row and raised `sales_daily` by its units;
  "MuscleBlaze whey under 3000" on Ask returned matches sorted by price.

## TabPFN
- **Code:** `forecast/forecast.py`, `scripts/forecast-publish.ts`, `src/ops.ts` (`forecastDemand`).
- **How:** per product and day, features are product, weekday, time index and 7- and 28-day means; the target is
  units sold. The model rolls forward 7 days. Output is checked in Node (finite, not negative) before use.
- **On Render:** Render has no Python, so `npm run forecast:publish` runs TabPFN on a laptop (212 products in chunks
  of 50, 317 s on an Apple M5 CPU) and stores the predictions in `forecastRuns`. The server uses the newest run up
  to `FORECAST_RUN_MAX_AGE_HOURS` old (default 30 days); stock, held units and risk are still worked out live.
  Products a run does not cover use the 7-day average and are marked.
- **Honesty:** the demand TabPFN learns from is estimated from Google searches, not her till sales; Forecast and
  Health say so. "Next 7 days", days of stock, risk and reorder quantity all come from the forecast, so Today,
  Forecast and Ask give the same numbers.
- **Checked live:** Health shows TabPFN Live for 212 products; "Work it out again" keeps it live.

## ElevenLabs
- **Code:** `src/integrations.ts` (`elevenSTT`, `elevenTTS`), `public/voice.js`, `POST /api/voice/order`,
  `POST /api/voice/stt`, `POST /api/voice/tts`.
- **Speech to text:** Scribe (`scribe_v1` unless `ELEVENLABS_STT_MODEL` is set) with `tag_audio_events=false`; a
  transcript that is only sound tags ("[music]") counts as no speech. Used for voice notes on Orders (recorded in the
  browser or a forwarded WhatsApp `.opus`) and for spoken questions on Ask.
- **Text to speech:** "Read aloud" on answers (`eleven_flash_v2_5`).
- **Status:** Health says Live only when the key is accepted by `GET /v1/user`.
- **Checked live:** an uploaded clip was heard as "राहुल भाई को 2 MB Biozyme भेज देना कल तक" and drafted as an
  order; a recorded clip did the same; the spoken question "मुझे क्या restock करना चाहिए?" was answered; Read aloud
  returned audio.

## SerpApi
- **Code:** `src/integrations.ts` (`serpShopping`), `src/ops.ts` (`supplierRefresh`, `livePrices`),
  `scripts/import/trends.ts`.
- **Prices:** `engine=google_shopping`, `gl=in`, for the products most likely to run out (`SUPPLIER_REFRESH_MAX`,
  default 5), each morning and when she runs Online prices; also on demand from Suppliers and Ask. A listing counts
  as comparable only if it shares a brand word and sits within half to double her price, so sachets and other
  brands are not shown as "cheapest". Results are cached in `supplierPrices`; blocked suppliers are hidden.
- **Trends:** `engine=google_trends` (India, 5 years) supplied the search-interest series behind the demand
  estimate.
- **Checked live:** Online prices ran from Workflows; Suppliers search for "MB biozyme whey" listed shop prices
  with links.

## Backboard
- **Code:** `src/integrations.ts` (`backboardSave`, `backboardList`, `backboardSearch`), `src/ops.ts`.
- **How:** base `https://app.backboard.io/api`, header `X-API-Key`; one assistant created once (id kept in
  `meta`), memories saved with `POST /assistants/{id}/memories` and found with `.../memories/search`. Her words go to
  Backboard; the structured rule (for example "block Supplier C") stays in MongoDB as the source of truth. Supplier
  answers merge rules found in either place. Saving the same rule twice keeps one copy.
- **Checked live:** a note saved on Suppliers appeared in the memory list and on Ask ("What preferences have I
  saved?"). The example questions on Ask are read-only, so a tap never saves a block.

## Sentry
- **Code:** `src/instrument.ts`, `src/integrations.ts` (`span`, `traced`).
- **How:** preloaded with `node --import`; spans follow the AI agent conventions (`gen_ai.invoke_agent`,
  `gen_ai.chat` with model and token counts, `gen_ai.execute_tool`) plus `tool.serpapi`, `memory.backboard`,
  `voice.stt`, `voice.tts`, `forecast.tabpfn` and each workflow step. Prompts, answers and customer details are sent
  as `[redacted N chars]` unless `SENTRY_SEND_CONTENT=1`. Express 5xx errors and failed jobs are captured.
- **Checked:** span tree, attributes and redaction in `test/sentry.test.ts` with the real SDK; Health shows Live on
  Render. The same steps show on the Activity page.

## Render
- **Config:** `render.yaml`, one free web service in Singapore, Node 24, health check `/api/health`. Deploys are
  made with the Render CLI for a specific commit. Health shows a Render row only when the `RENDER` variable is set.
- **Keep-alive:** `.github/workflows/keep-alive.yml` pings `/api/health` every 10 minutes until 15 Oct 2026.

## Keploy
- **Config:** `keploy.yml`, cases in `keploy/real-data-partners-1/`.
- **What:** 15 recorded API calls (health, dashboard, forecast, Ask, order reading, voice, catalogue search) replayed
  against a local server with Tiger unset, so the mocks stay stable. They sit alongside the 137 `npm test` tests.

## Temporal
- **Code:** `src/temporal/` (workflows, worker, schedule).
- **How:** `dailyBriefWorkflow` runs low-stock check, forecast, online prices and the brief, with 5 attempts and
  backoff per step; the brief still completes if online prices fail. The worker registers a `daily-brief` schedule
  at 08:00 Asia/Kolkata.
- **On Render:** no worker (free plan), so Health shows Standby. The same steps run inside the app with a retry
  loop, and the app writes the 08:00 brief itself; if that run fails it tries again 10 minutes later.
- **Checked locally:** with `SUPPLIER_FAIL_FIRST_N=2` the supplier step failed twice and passed on attempt 3; the
  workflow resumed after the worker was killed and restarted.

## Mastra
- **Code:** `src/agent.ts`.
- **How:** one tool table is registered with Mastra (`createTool` on an `Agent`). Mastra's native tool calling is
  used only with a model that advertises tool support; with Gemma here, Gemma returns `{tool, args}` JSON that is
  validated against the same tools, and a keyword router covers invalid replies. Health shows Standby for that
  reason. Native tool calls were checked locally with `qwen3:8b` as a stand-in.
