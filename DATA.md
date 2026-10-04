# Data sources

Nivara ships a **real retail stand-in** until the shop owner imports their own catalogue and orders.
`npm run seed` loads that stand-in. The old synthetic generator is `npm run seed:demo`.

| Dataset | Role | License | URL | Local cache | Fetched |
|---|---|---|---|---|---|
| **Open Food Facts** | Product identity (name, brand, categories, sugar) for Indian-relevant dietary supplements / protein / creatine / pre-workout | ODbL | https://world.openfoodfacts.org | `data/real/products.json` | see `fetchedAt` in that file |
| **UCI Online Retail** (dataset 352) | Daily demand *shapes* (90-day series) mapped onto our SKUs | CC BY 4.0 | https://archive.ics.uci.edu/dataset/352/online+retail | `data/real/uci-patterns.json` | see `fetchedAt` in that file |
| **SerpApi Google Shopping** (`gl=in`) | Live supplier/retail quotes per SKU (timestamp + link) | SerpApi ToS | https://serpapi.com | Mongo `supplierPrices` | on Temporal `supplierRefresh` |
| **Owner CSV / WhatsApp export** | Real orders | owner data | — | via `npm run import:orders` | when the owner provides files |

## Transforms

### Catalogue (`npm run data:catalog` → `scripts/fetch-catalog.ts`)
- Queries OFF CGI search with User-Agent `Nivara/0.1 (…)`.
- Keeps products whose name matches protein/whey/creatine/pre-workout/BCAA/gainer; drops Bournvita, Chyawanprash, Horlicks, etc.
- **Our fields** (`price`, `cost`, `stock`, `supplierId`, `leadTimeDays`) are shop-ops values derived deterministically from the OFF code hash — not OFF prices.
- `origin` + `tags` record OFF code, URL, brand, sugar/100g.

### Sales (`npm run data:uci` + seed / `import:sales`)
Mapping (deterministic, documented in `scripts/import-sales.ts`):
1. Rank catalogue products by price (desc).
2. Assign UCI pattern rank `i` → product rank `i` (modulo pattern count).
3. Rescale each UCI daily series so its mean matches a category baseline (`powder` 0.8, `bars` 3.0, `accessories` 1.0, `food` 1.5 units/day).
4. Align the 90-day window to end yesterday (`BUSINESS_TZ`).

UCI descriptions are UK giftware — we use **only the demand shapes**, never the product names.

### Tiger Data
On seed (when `TIGER_DATABASE_URL` is set): `sales_daily` hypertable + continuous aggregates `sales_demand_7d` / `sales_demand_28d`, and `catalog_items` with `tsvector` (+ optional `gemini-embedding-001` vectors) for hybrid `searchCatalog`.

### Owner import
- CSV: `data/samples/orders.csv` column shape.
- WhatsApp `.txt` export: lines that look like orders → Gemma `extractOrder` → inserted as pending drafts’ confirmed orders when extraction succeeds.

## Refresh

```bash
npm run data:catalog   # re-hit Open Food Facts → data/real/products.json
npm run data:uci       # re-download UCI zip → data/real/uci-patterns.json
npm run seed           # wipe ops collections and load real stand-in (+ Tiger sync)
npm run import:orders -- --csv data/samples/orders.csv
```
