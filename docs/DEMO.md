# Demo (under 2 minutes)

Before recording: `npm run seed`, Ollama running with the Gemma model, Temporal dev server + worker started
with `SUPPLIER_FAIL_FIRST_N=2`, server on http://localhost:3000.

| Time | Screen | Say / do |
|---|---|---|
| 0:00 | Dashboard | "My friend sells protein bars and shakers on WhatsApp. Every morning he asks: what needs my attention?" Point at overdue order, stockout-risk table, supplier savings. |
| 0:15 | Dashboard → **Generate today's brief** | Temporal runs the daily workflow. Gemma writes the brief from facts only. |
| 0:30 | Workflows page / Temporal UI | Show the supplier activity failing twice (simulated outage) and succeeding on attempt 3; the brief still completes. |
| 0:45 | Assistant → "What should I restock?" then "Why are you recommending this?" | Answer cites available stock, 7-day forecast, days of cover vs lead time, reorder qty. Open "Source data" to show the numbers come from the DB. |
| 1:00 | Assistant → "Remember that I don't buy from Supplier C" | Saved as a supplier block (Mongo; Backboard if keyed). Suppliers page: Supplier C now skipped in opportunities. |
| 1:15 | Orders → paste "Rahul wants 3 chocolate bars and one shaker, deliver tomorrow" → Extract | Gemma JSON → validated → matched to Rahul Verma, Chocolate Protein Bar, Shaker Bottle; "tomorrow" resolved by code to a date. Confirm → saved. |
| 1:35 | Forecast page | TabPFN label (or the clearly-marked fallback). |
| 1:45 | Activity page → Spans | Model call, tool call, latency for the last answer. Health page: which integrations are live vs fallback. |
