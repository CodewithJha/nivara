#!/usr/bin/env node
/**
 * Map UCI Online Retail (CC BY 4.0) daily demand patterns onto our catalogue.
 *
 * Mapping (deterministic):
 * 1. Rank catalogue products within each category by price (desc) — proxies "premium → volume".
 * 2. Rank UCI patterns by totalQty (already sorted in uci-patterns.json).
 * 3. Assign UCI rank i → product rank i within the same global order
 *    (flatten categories: powder, bars, accessories, food — whatever is in the catalogue).
 * 4. Scale each UCI daily series so its mean matches a category baseline
 *    (powder 0.8, bars 3.0, accessories 1.0, food 1.5 units/day), then poisson-sample
 *    is NOT used — we keep the real UCI shape, only rescale amplitude.
 * 5. Align the 90-day window to end yesterday (business TZ via daysAgo).
 *
 * Refresh patterns: `npm run data:uci` (downloads + parses the UCI xlsx with stdlib Python).
 * Apply into Mongo: this script (also called from `npm run seed`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { client, col, daysAgo, today, type Product, type Sale } from '../src/db.ts';

const PATTERNS = fileURLToPath(new URL('../data/real/uci-patterns.json', import.meta.url));
const BASELINE: Record<string, number> = { powder: 0.8, bars: 3.0, accessories: 1.0, food: 1.5 };

export function mapSales(products: Product[], patterns: { daily: number[]; mean: number }[], end = today()): Sale[] {
  const ranked = [...products].sort((a, b) => b.price - a.price || a._id.localeCompare(b._id));
  const sales: Sale[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    const pat = patterns[i % patterns.length];
    const target = BASELINE[p.category] ?? 1;
    const scale = pat.mean > 0 ? target / pat.mean : 0;
    const series = pat.daily.slice(-90);
    for (let d = 0; d < series.length; d++) {
      const qty = Math.max(0, Math.round(series[d] * scale));
      if (!qty) continue;
      sales.push({ sku: p._id, date: daysAgo(series.length - d, end), qty, demo: false });
    }
  }
  return sales;
}

export async function importSales() {
  if (!existsSync(PATTERNS)) throw new Error(`Missing ${PATTERNS}; run npm run data:uci`);
  const doc = JSON.parse(readFileSync(PATTERNS, 'utf8'));
  const products = await col.products.find().toArray();
  if (!products.length) throw new Error('No products in DB — import catalogue first');
  const sales = mapSales(products, doc.patterns);
  await col.sales.deleteMany({});
  if (sales.length) await col.sales.insertMany(sales);
  await col.sales.createIndex({ sku: 1, date: 1 });
  return { products: products.length, sales: sales.length, source: doc.source, window: `${doc.windowStart}…${doc.windowEnd}` };
}

if (import.meta.main) {
  await client.connect();
  console.log('imported sales', await importSales());
  await client.close();
}
