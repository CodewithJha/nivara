#!/usr/bin/env node
/** Open Prices INR quotes (ODbL), joined to catalog by product code. */
import { fileURLToPath } from 'node:url';
import { ACCESS_DATE, UA } from './config.ts';
import { fetchJson, readJson, writeJson } from './http.ts';

const RAW = fileURLToPath(new URL('../../data/raw/open_prices_inr.json', import.meta.url));

export type PriceRow = { code: string; price: number; date: string; city: string };

export async function fetchPricesRaw(maxPages = 5): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://prices.openfoodfacts.org/api/v1/prices?currency=INR&size=100&page=${page}`;
    let j: any;
    try { j = await fetchJson(url, { delayMs: 2000 }); }
    catch { break; }
    const batch = j.items ?? j.results ?? [];
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < 100) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  writeJson(RAW, { fetchedAt: new Date().toISOString(), accessDate: ACCESS_DATE, source: 'Open Prices', license: 'ODbL', url: 'https://prices.openfoodfacts.org', userAgent: UA, items });
  return items;
}

/** Latest INR price per product code. */
export function indexPrices(items: any[]): Map<string, number> {
  const best = new Map<string, { price: number; date: string }>();
  for (const it of items) {
    const code = String(it.product_code ?? it.product?.code ?? '').trim();
    const price = Number(it.price ?? it.price_per_unit);
    const date = String(it.date ?? it.created ?? '');
    if (!code || !Number.isFinite(price) || price <= 0) continue;
    const prev = best.get(code);
    if (!prev || date >= prev.date) best.set(code, { price, date });
  }
  return new Map([...best].map(([c, v]) => [c, v.price]));
}

export function priceRows(items: any[]): PriceRow[] {
  return items.flatMap((it: any) => {
    const code = String(it.product_code ?? it.product?.code ?? '').trim();
    const price = Number(it.price ?? it.price_per_unit);
    if (!code || !Number.isFinite(price) || price <= 0) return [];
    return [{ code, price, date: String(it.date ?? '').slice(0, 10), city: String(it.location?.city ?? it.city ?? '') }];
  });
}

export async function importPrices({ online = true } = {}) {
  let items = readJson<{ items: any[] }>(RAW)?.items;
  if (online) {
    try { items = await fetchPricesRaw(); }
    catch (e: any) { if (!items?.length) throw e; console.warn('prices: API failed, using cache', e.message); }
  }
  if (!items) items = [];
  const byCode = indexPrices(items);
  return { items: items.length, codes: byCode.size, byCode, rows: priceRows(items) };
}

if (import.meta.main) {
  const r = await importPrices({ online: process.argv.includes('--online') || !readJson(RAW) });
  console.log({ items: r.items, codes: r.codes });
}
