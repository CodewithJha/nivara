#!/usr/bin/env node
/**
 * Per-SKU weekly demand = trends index(type) × SKU share within type.
 * Expanded to daily for TabPFN/Mongo (qty/7 each day). Every row source:"proxy".
 */
import { fileURLToPath } from 'node:url';
import { writeJson } from './http.ts';
import type { CatalogProduct } from './catalog.ts';
import type { TrendPoint } from './trends.ts';

const OUT = fileURLToPath(new URL('../../data/real/demand_proxy.json', import.meta.url));

export type ProxySale = { sku: string; date: string; qty: number; source: 'proxy'; demo: false };

/** Equal share within productType (deterministic). */
export function skuShare(catalog: { _id: string; productType: string }[]) {
  const counts = new Map<string, number>();
  for (const p of catalog) counts.set(p.productType, (counts.get(p.productType) ?? 0) + 1);
  const share = new Map<string, number>();
  for (const p of catalog) share.set(p._id, 1 / (counts.get(p.productType) ?? 1));
  return share;
}

/** Scale Trends 0–100 → ~units/week via type baseline. */
const TYPE_BASE: Record<string, number> = {
  whey: 12, creatine: 6, multivitamin: 5, omega: 4, bcaa: 4, preworkout: 5, ayurvedic: 8, other: 3,
};

export function weeklyDemand(
  catalog: CatalogProduct[],
  trends: TrendPoint[],
): { week: string; sku: string; qty: number; productType: string }[] {
  const share = skuShare(catalog);
  const byTypeWeek = new Map<string, number>();
  for (const t of trends) byTypeWeek.set(`${t.productType}|${t.week}`, t.value);
  const weeks = [...new Set(trends.map(t => t.week))].sort();
  const out: { week: string; sku: string; qty: number; productType: string }[] = [];
  for (const p of catalog) {
    const base = TYPE_BASE[p.productType] ?? 3;
    const sh = share.get(p._id) ?? 0;
    for (const week of weeks) {
      const idx = byTypeWeek.get(`${p.productType}|${week}`) ?? 0;
      const qty = Math.round(((idx / 100) * base * sh) * 100) / 100;
      if (qty > 0) out.push({ week, sku: p._id, qty, productType: p.productType });
    }
  }
  return out;
}

/** Expand each week to 7 daily rows (Mon→Sun), for HISTORY_DAYS-style forecasts. */
export function expandWeeklyToDaily(weekly: { week: string; sku: string; qty: number }[]): ProxySale[] {
  const sales: ProxySale[] = [];
  for (const w of weekly) {
    const daily = Math.round((w.qty / 7) * 100) / 100;
    if (daily <= 0) continue;
    const start = Date.parse(w.week + 'T00:00:00Z');
    if (Number.isNaN(start)) continue;
    for (let d = 0; d < 7; d++) {
      const date = new Date(start + d * 864e5).toISOString().slice(0, 10);
      sales.push({ sku: w.sku, date, qty: daily, source: 'proxy', demo: false });
    }
  }
  return sales;
}

/** Keep last N calendar days for Atlas/Tiger inserts (forecast uses ~60d). */
export function recentDaily(daily: ProxySale[], keepDays = 90): ProxySale[] {
  if (!daily.length) return daily;
  const max = daily.reduce((m, d) => (d.date > m ? d.date : m), daily[0].date);
  const end = Date.parse(max + 'T00:00:00Z');
  const cut = new Date(end - (keepDays - 1) * 864e5).toISOString().slice(0, 10);
  return daily.filter(d => d.date >= cut);
}

export function buildDemand(catalog: CatalogProduct[], trends: TrendPoint[], { keepDays = 90 } = {}) {
  const weekly = weeklyDemand(catalog, trends);
  const daily = recentDaily(expandWeeklyToDaily(weekly), keepDays);
  const doc = {
    source: 'proxy',
    label: 'Demand: search-interest proxy, not real sales',
    method: 'trends_index(type) × equal_sku_share(type) × type_baseline',
    accessDate: '2026-10-04',
    weeklyCount: weekly.length,
    dailyCount: daily.length,
    keepDays,
    // slim cache: sample weeks only (full series rebuilt from catalog × trends on seed)
    sampleWeekly: weekly.slice(0, 20),
  };
  writeJson(OUT, doc);
  return { weekly, daily, path: OUT, label: doc.label };
}

if (import.meta.main) {
  const { readJson } = await import('./http.ts');
  const { loadTrendsCache } = await import('./trends.ts');
  const cat = readJson<{ products: CatalogProduct[] }>(fileURLToPath(new URL('../../data/real/products.json', import.meta.url)));
  if (!cat?.products?.length) throw new Error('run catalog import first');
  const r = buildDemand(cat.products, loadTrendsCache());
  console.log({ weekly: r.weekly.length, daily: r.daily.length, label: r.label, path: r.path });
}
