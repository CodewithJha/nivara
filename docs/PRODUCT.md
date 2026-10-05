# Product

<!-- impeccable:product-schema 1 -->

## Platform

Web, phone first. Live at https://nivara-x9iv.onrender.com.

## Users

One person: my friend, who runs a supplements shop in India on her own and sells through WhatsApp and Instagram
(whey, protein bars, creatine, omega-3, chyawanprash). No staff, no ERP. She opens Nivara on her phone between
customer chats, and sometimes on a laptop, to answer one question: what needs me today?

## Product purpose

Every day, tell her three things: which orders to deliver, what to reorder before it runs out, and whether a
supplier is charging too much. Success: she acts on Today in a minute and never learns about a stockout from a
customer.

## Positioning

Facts come from her own data and plain code (stock maths, risk rules, supplier thresholds, dates). The language
model reads messages and phrases answers; it does not supply numbers or write to the database. Every
recommendation says why. The same app can run on her own laptop with an open model (Gemma) so customer and margin
data does not have to leave it.

## Operating context

- Orders arrive as chat messages and Hinglish voice notes. She pastes the text, records a note, or uploads a
  forwarded one; Nivara drafts the order and she confirms it.
- A morning brief is written at 08:00 IST (Temporal when a worker runs, otherwise inside the app).
- Used in short glances on a phone. Money is rupees with Indian grouping (₹1,02,499).

## Capabilities

- **Today:** jobs in order of weight (do now, this week, when you can), each with its action; deliver list,
  restock list with how many to order, cheaper quotes, online prices, the morning brief, a short Ask box.
- **Ask:** typed or spoken questions in English or Hinglish, answers read aloud on request. Example questions are
  read-only.
- **Orders:** voice note or message → draft with what was heard, matched customer and products, prices and
  delivery date → Confirm and save. Short order numbers. Mark delivered updates stock and sales history.
- **Stock:** every product with stock, price, cost, supplier and delivery time, grouped by category.
- **Forecast:** next 7 days per product (TabPFN), days of stock against delivery time, risk, how many to order,
  with a plain note on where the demand estimate comes from.
- **Suppliers:** stored quotes against what she pays (a saving counts at ₹10 and 5% a unit or more), an online
  price check, and rules she wants remembered.
- **Workflows, Activity, Health:** run a job now, see each answer step by step, see which services are Live or on
  Standby.

## Constraints

- Plain HTML and JS, no build, no framework. Every number on screen comes from the API.
- Not built: login, payments, WhatsApp Business connection, native app.
- One shop.

## Brand commitments

- Name: Nivara.
- Voice: plain shopkeeper English. "3 orders to deliver today", not "16 things need your attention". No "AI-powered",
  "copilot", "magic", "seamless". No codes, ids, field names or decimals on her pages.
- Honest labels: estimated demand, estimated prices and standby services are named as such.

## Evidence on hand

212 real products from Open Food Facts India, 4 observed prices from Open Prices and estimated prices for the rest,
demand estimated from Google Trends, 8 sample customers and orders. No real customers, testimonials or metrics; do
not invent them.

## Product principles

1. Today first: the screen answers "what do I do now" before anything else.
2. Show the reason: each recommendation says why (days of stock against delivery time, the saving per unit).
3. Rupees and counts, not scores.
4. Works one-handed on a phone: menu behind a button below 900px, tap targets at least 44px, long lists load as
   she scrolls.
5. Nothing is saved from a message or voice note until she confirms it.

## Accessibility and inclusion

WCAG AA contrast, visible keyboard focus, reduced motion respected, usable at 360px. English UI; Hindi, Hinglish
and Devanagari accepted in messages and voice notes.
