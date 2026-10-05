---
title: "Nivara: a local-Gemma ops copilot for my friend's WhatsApp supplements shop"
tags: hacktoberfest, ai, opensource, gemma
---

*This is a submission for the Hacktoberfest 2026 Weekend Challenge.*

## The person I built it for

My friend sells protein bars, whey, shakers and gym accessories, all through WhatsApp and Instagram DMs. He's
the whole company. Orders arrive as chat messages, stock lives in a notebook, and the first sign that his
best-selling chocolate bar has run out is a customer asking for it.

Every morning he has the same question: **what needs my attention today?** Not "chat with my data". Just:
what do I deliver, what do I reorder before it runs out, and am I overpaying anyone?

## What I built

**Nivara** is an operations copilot that answers that question:

- A dashboard with today's brief, stockout-risk products with reorder quantities, overdue and pending orders,
  7-day projected demand, cheaper-supplier opportunities and recent customer activity.
- An assistant (typed or spoken) for "What should I restock?", "Why?", "What sold most this week?",
  "Find cheaper suppliers for this", "Remember I don't buy from Supplier C".
- Paste a messy order ("Rahul wants 3 chocolate bars and one shaker, deliver tomorrow") and get a validated draft
  matched to real products and customers, with the date resolved, ready to confirm.

## The one rule: Gemma does language, code does facts

Small businesses can't afford a confidently wrong number. So the architecture has a hard line:

- **Gemma (open-weight, running locally in Ollama)** understands the question, picks a tool, extracts orders
  into JSON, and turns facts into a readable explanation or morning brief.
- **Deterministic code** owns everything that must be right: DB writes, zod validation, stock maths
  (`available = stock − reserved for pending orders`, days of cover, lead-time-aware risk, reorder quantity),
  date resolution ("tomorrow", "friday", "12 oct"), and workflow state.

Gemma never writes to the database. Its order JSON is validated, then matched to real SKUs and customers by
code, then shown to the human. Its answers are generated from tool output only, and the UI shows that tool
output ("Source data") under every answer, so every number is traceable to a DB record.

## Why an open-weight model

Customer names, phone orders and margins are exactly what a one-person business shouldn't have to send to a
closed API by default. Gemma 3 4B runs on the laptop he already owns, costs nothing per message, and keeps
working if a vendor changes pricing. When I want more capability it's one env var: `GEMMA_MODEL=gemma3:12b`, or
`gemma4:e4b`, which advertises native tool calling in Ollama and automatically switches the agent onto the
Mastra native-tools route.

Being honest about small models: `gemma3` in Ollama doesn't expose native tool calling. So the agent has three
routes, best first: Mastra native tools (when the model supports them), then Gemma choosing a tool by emitting
JSON that zod validates, then a deterministic keyword router if Gemma is down or emits junk. Every answer is
labelled with the route that produced it.

## Partner tech, and what each one does

- **MongoDB**: source of truth for products, customers, orders, daily sales, suppliers, preferences, briefs and traces.
- **Temporal**: the daily brief is a real workflow (low-stock check → forecast → supplier refresh → brief) on a
  08:00 IST schedule. I added a flag that makes the supplier activity fail its first N attempts; Temporal retries
  with backoff and the brief completes. If Temporal isn't reachable, the same activities run in-process, labelled.
- **Mastra**: the agent and tool registry (`createTool` for all eight tools).
- **TabPFN**: 7-day demand regression per product from 60 days of sales. If it can't run, a moving average takes
  over and is labelled `fallback-moving-average` everywhere. No silent fakes.
- **Sentry**: AI agent spans (invoke_agent → chat → execute_tool) with model, tokens, tool I/O and latency, mirrored
  into a local trace view so the demo works without a DSN.
- **SerpApi**: Google Shopping price search with source links; without a key the app says search is unavailable
  instead of guessing.
- **Backboard**: long-term memory mirror for preferences like "never buy from Supplier C", which actually filters
  supplier suggestions.
- **ElevenLabs**: Scribe speech-to-text and TTS; falls back to the browser's Web Speech API.

## Engineering choices I'd defend

- **No build step.** Node 26 runs TypeScript natively; the frontend is one HTML file and one JS file.
- **One tool table** feeds Mastra, the JSON router, the keyword router, and Temporal activities.
- **Graceful degradation is a feature.** `/api/health` lists every integration as live or fallback, and the UI
  shows the same labels.
- **Small tests where bugs would hurt**: reorder maths, stockout rules, extraction validation, date resolution.

## What's next

WhatsApp Business ingestion (the extraction pipeline is ready for it), one-click purchase orders to suppliers, and
pack-size normalisation so web prices compare cleanly with wholesale unit costs.

*Repo: (link) · Demo video: (link)*
