# Data sources

Nivara ships a **supplement-specific real stand-in** until the shop owner imports their own orders.
`npm run seed` loads it into **Atlas (ops)** and **Tiger (analytics)**. Demo generator: `npm run seed:demo`.

| Dataset | Role | License | URL | Local cache | Access date |
|---|---|---|---|---|---|
| **Open Food Facts (India)** | Catalogue identity (name, brand, categories) for dietary / bodybuilding / protein products | ODbL | https://world.openfoodfacts.org | `data/raw/off_india.json` → `data/real/products.json` | 2026-10-04 |
| **Open Prices** | INR observed prices joined by `product_code`; missing → `priceSource:"manual"` by productType | ODbL | https://prices.openfoodfacts.org | `data/raw/open_prices_inr.json` | 2026-10-04 |
| **Google Trends IN** (SerpApi `engine=google_trends`, geo=IN) | Search-interest index per productType (5y weekly; partial week dropped) | SerpApi / Google | SerpApi google_trends | `data/raw/trends_in.csv` | 2026-10-04 |
| **Proxy demand** | `trends_index(type) × equal_sku_share(type) × type_baseline` → weekly then daily | derived | — | `data/real/demand_proxy.json` | 2026-10-04 |
| **SerpApi Google Shopping** | Live supplier refresh (Temporal) | SerpApi ToS | https://serpapi.com | Mongo `supplierPrices` | on refresh |
| **Owner CSV / WhatsApp** | Real orders | owner | — | `npm run import:orders` | when provided |

## Demand labelling

Every derived series is `source:"proxy"`. UI + API show:

> **Demand: search-interest proxy, not real sales**

This is **not** POS/order history. Delivered owner orders sync into Tiger separately (Atlas change stream / backfill).

## Pipeline

```bash
npm run data:catalog   # OFF India → data/raw + data/real/products.json
npm run data:prices    # Open Prices INR
npm run data:trends    # Google Trends → data/raw/trends_in.csv (needs SERPAPI_API_KEY; else uses cache)
npm run data:demand    # proxy weekly/daily from catalog × trends
npm run seed           # import → Atlas products/sales + Tiger hypertable + catalog embeddings
npm run seed -- --offline   # use cached raw files only
```

Importers live in `scripts/import/{catalog,prices,trends,demand}.ts` and are idempotent / offline-capable.
