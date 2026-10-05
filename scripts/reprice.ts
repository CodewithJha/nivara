#!/usr/bin/env node
/**
 * Re-run the price estimator on the stored catalogue and update only what pricing owns:
 * product price/cost (+ estimate tags), supplier quotes (they follow cost) and Tiger's price copy.
 * Unlike `npm run seed` it keeps orders, customers, sales and published forecasts. `--dry` only lists changes.
 */
import { fileURLToPath } from 'node:url';
import { client, col } from '../src/db.ts';
import { toShopProducts, type CatalogProduct } from './import/catalog.ts';
import { importPrices } from './import/prices.ts';
import { buildSuppliers } from './import/supplier-quotes.ts';
import { readJson } from './import/http.ts';
import { invalidateDay } from '../src/ops.ts';
import { poolForSync } from '../src/tiger.ts';

export async function reprice({ dry = false } = {}) {
  const catalog = readJson<{ products: CatalogProduct[] }>(fileURLToPath(new URL('../data/real/products.json', import.meta.url)))!.products;
  const next = toShopProducts(catalog, (await importPrices({ online: false })).byCode);
  const stored = new Map((await col.products.find({}, { projection: { price: 1, cost: 1, name: 1 } }).toArray()).map(p => [p._id, p]));
  const changed = next.filter(p => stored.has(p._id) && (stored.get(p._id)!.price !== p.price || stored.get(p._id)!.cost !== p.cost));
  const report = changed.map(p => ({ sku: p._id, name: p.name, price: [stored.get(p._id)!.price, p.price], cost: [stored.get(p._id)!.cost, p.cost] }));
  if (dry || !changed.length) return { changed: report, dry };
  for (const p of changed) await col.products.updateOne({ _id: p._id }, { $set: { price: p.price, cost: p.cost, priceSource: p.priceSource, tags: p.tags } });
  // quotes are a deterministic ratio of each product's cost, so rebuild them from the stored list with new costs
  const products = (await col.products.find({}, { projection: { cost: 1, supplierId: 1 } }).toArray()) as any[];
  for (const s of buildSuppliers(products)) await col.suppliers.updateOne({ _id: s._id }, { $set: { quotes: s.quotes } });
  await invalidateDay();
  let tiger = 0;
  const pool = poolForSync();
  if (pool) for (const p of changed) tiger += (await pool.query('UPDATE catalog_items SET price = $2, tags = $3::jsonb WHERE sku = $1', [p._id, p.price, JSON.stringify(p.tags)])).rowCount ?? 0;
  await pool?.end();
  return { changed: report, tiger };
}

if (import.meta.main) {
  await client.connect();
  console.log(JSON.stringify(await reprice({ dry: process.argv.includes('--dry') }), null, 1));
  await client.close();
  process.exit(0);
}
