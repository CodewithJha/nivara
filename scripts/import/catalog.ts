#!/usr/bin/env node
/** Open Food Facts India dietary/bodybuilding/protein catalogue (ODbL). Offline from cache when API fails. */
import { fileURLToPath } from 'node:url';
import { ACCESS_DATE, KEEP_RE, MANUAL_COST_RATIO, MANUAL_PRICE, UA, categoryFor, productType } from './config.ts';
import { fetchJson, readJson, writeJson } from './http.ts';

const RAW = fileURLToPath(new URL('../../data/raw/off_india.json', import.meta.url));
const OUT = fileURLToPath(new URL('../../data/real/products.json', import.meta.url));
const CATS = ['dietary-supplements', 'bodybuilding-supplements', 'protein-powders'];
const hash = (s: string) => [...s].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);

export type CatalogProduct = {
  _id: string; code: string; name: string; brands: string; quantity: string; productType: string;
  category: string; aliases: string[]; image?: string; categories: string[];
};

export async function fetchCatalogRaw(maxPages = 3): Promise<any[]> {
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const cat of CATS) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `https://world.openfoodfacts.org/api/v2/search?countries_tags_en=india&categories_tags_en=${cat}&fields=code,product_name,brands,quantity,categories_tags,image_front_url&page_size=100&page=${page}`;
      let j: any;
      try { j = await fetchJson(url); }
      catch { break; }
      const products = j.products ?? [];
      if (!products.length) break;
      for (const p of products) {
        const code = String(p.code ?? '').trim();
        const name = String(p.product_name ?? '').trim();
        if (!code || !name || seen.has(code) || !KEEP_RE.test(name + ' ' + (p.brands ?? ''))) continue;
        seen.add(code);
        rows.push(p);
      }
      await new Promise(r => setTimeout(r, 6000));
      if (products.length < 100) break;
    }
  }
  writeJson(RAW, { fetchedAt: new Date().toISOString(), accessDate: ACCESS_DATE, source: 'Open Food Facts', license: 'ODbL', url: 'https://world.openfoodfacts.org', userAgent: UA, products: rows });
  return rows;
}

export function mapCatalog(rawProducts: any[]): CatalogProduct[] {
  const out: CatalogProduct[] = [];
  for (const p of rawProducts) {
    const code = String(p.code ?? '').trim();
    const name = String(p.product_name ?? '').trim();
    if (!code || !name || !KEEP_RE.test(name)) continue;
    const cats = (p.categories_tags ?? []).join(' ');
    const type = productType(name, cats);
    const brands = String(p.brands ?? '');
    out.push({
      _id: `R${String(out.length + 1).padStart(2, '0')}`,
      code, name: name.slice(0, 100), brands, quantity: String(p.quantity ?? ''),
      productType: type, category: categoryFor(type),
      aliases: [...new Set([name.toLowerCase(), brands.split(',')[0]?.trim().toLowerCase()].filter(Boolean))].slice(0, 5),
      image: p.image_front_url, categories: p.categories_tags ?? [],
    });
  }
  return out;
}

/** Attach shop price/cost/stock fields (Open Prices applied separately). */
export function toShopProducts(catalog: CatalogProduct[], prices: Map<string, number>) {
  return catalog.map(p => {
    const h = hash(p.code);
    const price = prices.get(p.code) ?? MANUAL_PRICE[p.productType] ?? MANUAL_PRICE.other;
    const priceSource = prices.has(p.code) ? 'open-prices' : 'manual';
    return {
      _id: p._id, name: p.name, aliases: p.aliases, category: p.category,
      price, cost: Math.round(price * MANUAL_COST_RATIO), stock: 4 + (h % 40),
      supplierId: ['S1', 'S2', 'S3', 'S4'][h % 4], leadTimeDays: 3 + (h % 5),
      productType: p.productType, priceSource,
      tags: { brands: p.brands, quantity: p.quantity, categories: p.categories, productType: p.productType, priceSource },
      origin: { source: 'openfoodfacts', code: p.code, url: `https://world.openfoodfacts.org/product/${p.code}`, license: 'ODbL' },
      demo: false,
    };
  });
}

export async function importCatalog({ online = true } = {}) {
  let raw = readJson<{ products: any[] }>(RAW)?.products;
  if (online) {
    try { raw = await fetchCatalogRaw(); }
    catch (e: any) { if (!raw?.length) throw e; console.warn('catalog: API failed, using cache', e.message); }
  }
  if (!raw?.length) throw new Error(`No catalog cache at ${RAW}`);
  const catalog = mapCatalog(raw);
  writeJson(OUT, {
    fetchedAt: new Date().toISOString(), accessDate: ACCESS_DATE,
    source: 'Open Food Facts (India)', license: 'Open Database License (ODbL)',
    url: 'https://world.openfoodfacts.org', userAgent: UA,
    note: 'Identity from OFF. Prices from Open Prices when available, else manual estimate by productType.',
    products: catalog,
  });
  return { raw: raw.length, catalog: catalog.length, path: OUT };
}

if (import.meta.main) console.log(await importCatalog({ online: process.argv.includes('--online') || !readJson(RAW) }));
