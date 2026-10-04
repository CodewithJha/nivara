#!/usr/bin/env node
/** Google Trends India via SerpApi → data/raw/trends_in.csv (committed fallback). */
import { fileURLToPath } from 'node:url';
import { ACCESS_DATE, PRODUCT_TYPES, TREND_QUERIES, type ProductType } from './config.ts';
import { fetchJson, readCsv, writeCsv } from './http.ts';

const OUT = fileURLToPath(new URL('../../data/raw/trends_in.csv', import.meta.url));

export type TrendPoint = { productType: ProductType; week: string; value: number };

/** Parse SerpApi google_trends timeline; drop the trailing partial week. */
export function parseTimeline(timeline: any[], productType: ProductType): TrendPoint[] {
  const pts = (timeline ?? []).flatMap((t: any) => {
    const week = String(t.date ?? t.timestamp ?? '').slice(0, 10);
    const value = Number(t.values?.[0]?.extracted_value ?? t.values?.[0]?.value ?? t.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(value)) return [];
    return [{ productType, week, value }];
  });
  // Drop last point (often partial current week)
  return pts.length > 1 ? pts.slice(0, -1) : pts;
}

export async function fetchTrendsOnline(): Promise<TrendPoint[]> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY missing');
  const all: TrendPoint[] = [];
  for (const type of PRODUCT_TYPES) {
    const u = new URL('https://serpapi.com/search.json');
    Object.entries({ engine: 'google_trends', q: TREND_QUERIES[type], geo: 'IN', date: 'today 5-y', api_key: key }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await fetchJson(u.toString(), { delayMs: 2000, retries: 3 });
    const timeline = j.interest_over_time?.timeline_data ?? j.interest_over_time ?? [];
    all.push(...parseTimeline(timeline, type));
    await new Promise(r => setTimeout(r, 1500));
  }
  writeCsv(OUT, ['productType', 'week', 'value', 'accessDate'], all.map(p => [p.productType, p.week, p.value, ACCESS_DATE]));
  return all;
}

export function loadTrendsCache(): TrendPoint[] {
  return readCsv(OUT).flatMap(r => {
    const value = Number(r.value);
    if (!PRODUCT_TYPES.includes(r.productType as ProductType) || !r.week || !Number.isFinite(value)) return [];
    return [{ productType: r.productType as ProductType, week: r.week, value }];
  });
}

export async function importTrends({ online = true } = {}) {
  let points = loadTrendsCache();
  if (online && process.env.SERPAPI_API_KEY) {
    try { points = await fetchTrendsOnline(); }
    catch (e: any) { if (!points.length) throw e; console.warn('trends: SerpApi failed, using cache', e.message); }
  }
  if (!points.length) throw new Error(`No trends cache at ${OUT}; run with SERPAPI_API_KEY`);
  return { weeks: new Set(points.map(p => p.week)).size, points, path: OUT };
}

if (import.meta.main) console.log(await importTrends({ online: process.argv.includes('--online') || !loadTrendsCache().length }));
