#!/usr/bin/env node
// Refresh data/real/products.json from Open Food Facts (ODbL). Prices/stock are ours; product identity is OFF.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UA = 'Nivara/0.1 (https://github.com; Hacktoberfest shop-ops; contact=nivara)';
const OUT = fileURLToPath(new URL('../data/real/products.json', import.meta.url));
const QUERIES = [
  { q: 'whey protein', category: 'powder', supplierId: 'S3', lead: 6, price: 2499, cost: 1780 },
  { q: 'creatine monohydrate', category: 'powder', supplierId: 'S3', lead: 6, price: 899, cost: 560 },
  { q: 'pre workout', category: 'powder', supplierId: 'S3', lead: 6, price: 1499, cost: 980 },
  { q: 'protein bar', category: 'bars', supplierId: 'S1', lead: 4, price: 95, cost: 55 },
  { q: 'BCAA', category: 'powder', supplierId: 'S3', lead: 6, price: 1199, cost: 780 },
  { q: 'mass gainer', category: 'powder', supplierId: 'S3', lead: 6, price: 2999, cost: 2150 },
  { q: 'plant protein', category: 'powder', supplierId: 'S3', lead: 6, price: 2299, cost: 1600 },
];
const NOISE = /\b(bournvita|chyawanprash|horlicks|complan|boost|pediasure|ensure|glucose|malt|chocolate drink|tea|coffee|biscuit|cookie mix)\b/i;
const WANT = /\b(protein|whey|creatine|pre[- ]?workout|bcaa|gainer|amino|isolate|casein|supplement)\b/i;

async function search(q: string, page = 1): Promise<any[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const u = new URL('https://world.openfoodfacts.org/cgi/search.pl');
    Object.entries({ search_terms: q, action: 'process', json: '1', page_size: '30', page: String(page), fields: 'code,product_name,brands,categories_tags_en,labels_tags_en,quantity,url,nutriments,countries_tags_en' })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) });
    const text = await r.text();
    if (!r.ok || text.startsWith('<')) {
      await new Promise(res => setTimeout(res, 800 * attempt));
      continue;
    }
    try { return (JSON.parse(text).products ?? []) as any[]; }
    catch { await new Promise(res => setTimeout(res, 800 * attempt)); }
  }
  return [];
}

const hash = (s: string) => [...s].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
const aliases = (name: string, brands: string) => {
  const base = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const brand = brands.split(',')[0]?.trim().toLowerCase();
  return [...new Set([base, brand && base.includes(brand) ? '' : `${brand} ${base}`.trim(), ...base.split(' ').filter(w => w.length > 4).slice(0, 3)]).values()].filter(Boolean).slice(0, 6);
};

const seen = new Set<string>();
const products: any[] = [];
for (const cfg of QUERIES) {
  const rows = await search(cfg.q);
  await new Promise(r => setTimeout(r, 400));
  for (const p of rows) {
    const name = String(p.product_name ?? '').trim();
    const code = String(p.code ?? '').trim();
    if (!name || !code || seen.has(code) || NOISE.test(name) || !WANT.test(name + ' ' + (p.brands ?? ''))) continue;
    const cats = (p.categories_tags_en ?? []).join(' ').toLowerCase();
    if (NOISE.test(cats)) continue;
    seen.add(code);
    const h = hash(code);
    const sugar = Number(p.nutriments?.sugars_100g);
    products.push({
      _id: `R${String(products.length + 1).padStart(2, '0')}`,
      name: name.slice(0, 80),
      aliases: aliases(name, String(p.brands ?? '')),
      category: cfg.category,
      price: cfg.price + (h % 7) * 10,
      cost: cfg.cost + (h % 5) * 8,
      stock: 4 + (h % 40),
      supplierId: cfg.supplierId,
      leadTimeDays: cfg.lead,
      tags: {
        brands: p.brands ?? '',
        quantity: p.quantity ?? '',
        sugarPer100g: Number.isFinite(sugar) ? sugar : null,
        labels: p.labels_tags_en ?? [],
        categories: p.categories_tags_en ?? [],
      },
      origin: { source: 'openfoodfacts', code, url: p.url ?? `https://world.openfoodfacts.org/product/${code}`, license: 'ODbL' },
    });
    if (products.filter(x => x.category === cfg.category).length >= 6) break;
  }
}

// Keep a compact shop catalogue (~24 SKUs). Prefer named brands; drop empties.
const picked = products.slice(0, 24);
if (picked.length < 8) throw new Error(`Open Food Facts returned too few usable products (${picked.length}); retry later`);

mkdirSync(fileURLToPath(new URL('../data/real', import.meta.url)), { recursive: true });
const doc = {
  fetchedAt: new Date().toISOString(),
  source: 'Open Food Facts',
  license: 'Open Database License (ODbL)',
  url: 'https://world.openfoodfacts.org',
  userAgent: UA,
  note: 'Identity/nutrition from OFF. price/cost/stock/supplierId are Nivara shop fields for ops demos until the owner imports their catalogue.',
  products: picked,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log('wrote', OUT, 'products', picked.length);
