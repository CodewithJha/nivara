// Real seed: OFF India + Open Prices + Trends proxy demand → Atlas (ops) + Tiger (analytics).
import { client, col, type Product } from './db.ts';
import { importCatalog, toShopProducts, type CatalogProduct } from '../scripts/import/catalog.ts';
import { importPrices } from '../scripts/import/prices.ts';
import { importTrends } from '../scripts/import/trends.ts';
import { buildDemand } from '../scripts/import/demand.ts';
import { readJson } from '../scripts/import/http.ts';
import { fileURLToPath } from 'node:url';
import { ensureTiger, syncCatalogToTiger, syncSalesToTiger, embedCatalog } from './tiger.ts';
import { backfillDeliveredOrders } from './sync.ts';

const suppliers = [
  { _id: 'S1', name: 'FitFuel Distributors', contact: 'Lucknow wholesale market', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S2', name: 'GymGear Wholesale', contact: 'Delhi, ships in 3 days', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S3', name: 'NutriHub India', contact: 'Authorised supplements distributor', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S4', name: 'Supplier C (Sports Mart)', contact: 'Kanpur, cheap but delays', quotes: [] as { sku: string; unitCost: number }[] },
];

const customers = ['Rahul Verma', 'Priya Singh', 'Aman Khan', 'Sneha Gupta', 'Vikram Rao', 'Neha Sharma', 'Arjun Mehta', 'Kavya Iyer']
  .map((name, i) => ({ _id: `C0${i + 1}`, name, channel: (i % 3 ? 'whatsapp' : 'instagram') as 'whatsapp' | 'instagram', demo: false }));

export async function seed({ online = !process.argv.includes('--offline') } = {}) {
  const catRes = await importCatalog({ online });
  const priceRes = await importPrices({ online });
  const trendRes = await importTrends({ online });
  const catalogDoc = readJson<{ products: CatalogProduct[] }>(fileURLToPath(new URL('../data/real/products.json', import.meta.url)))!;
  const demand = buildDemand(catalogDoc.products, trendRes.points);
  const products = toShopProducts(catalogDoc.products, priceRes.byCode) as Product[];

  for (const s of suppliers) {
    s.quotes = products.filter((_, i) => (i + s._id.charCodeAt(1)) % 3 !== 0).map(p => ({
      sku: p._id, unitCost: Math.round(p.cost * (s._id === 'S4' ? 0.85 : 0.92)),
    }));
  }

  for (const c of Object.values(col)) if (!['traces', 'meta'].includes(c.collectionName)) await c.deleteMany({});
  await col.products.insertMany(products);
  await col.customers.insertMany(customers);
  await col.suppliers.insertMany(suppliers.map(s => ({ ...s, demo: false })));
  if (demand.daily.length) await col.sales.insertMany(demand.daily);
  await col.preferences.insertOne({ text: 'Prefer suppliers that deliver within 5 days.', kind: 'note', createdAt: new Date(), mirror: 'local-only', demo: false } as any);
  await col.sales.createIndex({ sku: 1, date: 1 });
  await col.meta.replaceOne({ _id: 'data_sources' }, {
    _id: 'data_sources',
    value: {
      catalog: { source: 'Open Food Facts India', license: 'ODbL', accessDate: '2026-10-04', count: products.length },
      prices: { source: 'Open Prices', license: 'ODbL', accessDate: '2026-10-04', matched: [...priceRes.byCode.keys()].filter(c => catalogDoc.products.some(p => p.code === c)).length },
      trends: { source: 'Google Trends IN via SerpApi', accessDate: '2026-10-04', weeks: trendRes.weeks },
      demand: { source: 'proxy', label: demand.label, weekly: demand.weekly.length, daily: demand.daily.length },
      note: 'Demand is search-interest proxy, not real sales. Owner orders via import:orders.',
    },
  }, { upsert: true });

  let tiger: any = { status: 'skipped' };
  try {
    const t = await ensureTiger();
    if (t.ok) {
      await syncCatalogToTiger(products);
      await syncSalesToTiger(demand.daily);
      const emb = await embedCatalog(products);
      const bf = await backfillDeliveredOrders();
      tiger = { status: 'synced', detail: t.detail, embeddings: emb, orderBackfill: bf };
    } else tiger = { status: 'fallback', detail: t.detail };
  } catch (e: any) { tiger = { status: 'fallback', detail: e.message }; }

  return {
    products: products.length, pricesMatched: priceRes.codes, trendWeeks: trendRes.weeks,
    demandWeekly: demand.weekly.length, demandDaily: demand.daily.length, customers: customers.length,
    suppliers: suppliers.length, tiger, catalogRaw: catRes.raw,
  };
}

if (import.meta.main) {
  await client.connect();
  console.log('seeded real', await seed());
  await client.close();
  process.exit(0); // Tiger pg pool otherwise keeps the process alive
}
