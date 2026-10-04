// Real-data seed: Open Food Facts catalogue cache + UCI-mapped sales. Demo seed is `npm run seed:demo`.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { client, col, type Product } from './db.ts';
import { mapSales } from '../scripts/import-sales.ts';
import { ensureTiger, syncCatalogToTiger, syncSalesToTiger } from './tiger.ts';

const CATALOG = fileURLToPath(new URL('../data/real/products.json', import.meta.url));
const PATTERNS = fileURLToPath(new URL('../data/real/uci-patterns.json', import.meta.url));

const suppliers = [
  { _id: 'S1', name: 'FitFuel Distributors', contact: 'Lucknow wholesale market', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S2', name: 'GymGear Wholesale', contact: 'Delhi, ships in 3 days', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S3', name: 'NutriHub India', contact: 'Authorised supplements distributor', quotes: [] as { sku: string; unitCost: number }[] },
  { _id: 'S4', name: 'Supplier C (Sports Mart)', contact: 'Kanpur, cheap but delays', quotes: [] as { sku: string; unitCost: number }[] },
];

const customers = ['Rahul Verma', 'Priya Singh', 'Aman Khan', 'Sneha Gupta', 'Vikram Rao', 'Neha Sharma', 'Arjun Mehta', 'Kavya Iyer']
  .map((name, i) => ({ _id: `C0${i + 1}`, name, channel: (i % 3 ? 'whatsapp' : 'instagram') as 'whatsapp' | 'instagram', demo: false }));

export async function seed() {
  if (!existsSync(CATALOG)) throw new Error(`Missing ${CATALOG}; run npm run data:catalog`);
  if (!existsSync(PATTERNS)) throw new Error(`Missing ${PATTERNS}; run npm run data:uci`);
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const patterns = JSON.parse(readFileSync(PATTERNS, 'utf8'));
  const products: Product[] = catalog.products.map((p: any) => ({
    _id: p._id, name: p.name, aliases: p.aliases ?? [], category: p.category,
    price: p.price, cost: p.cost, stock: p.stock, supplierId: p.supplierId, leadTimeDays: p.leadTimeDays,
    tags: p.tags, origin: p.origin, demo: false,
  }));
  for (const s of suppliers) {
    s.quotes = products.filter((_, i) => (i + s._id.charCodeAt(1)) % 3 !== 0).map(p => ({
      sku: p._id, unitCost: Math.round(p.cost * (s._id === 'S4' ? 0.85 : 0.92 + (p.price % 7) / 100)),
    }));
  }
  const sales = mapSales(products, patterns.patterns);
  for (const c of Object.values(col)) if (!['traces', 'meta'].includes(c.collectionName)) await c.deleteMany({});
  await col.products.insertMany(products);
  await col.customers.insertMany(customers);
  await col.suppliers.insertMany(suppliers.map(s => ({ ...s, demo: false })));
  if (sales.length) await col.sales.insertMany(sales);
  await col.preferences.insertOne({ text: 'Prefer suppliers that deliver within 5 days.', kind: 'note', createdAt: new Date(), mirror: 'local-only', demo: false } as any);
  await col.sales.createIndex({ sku: 1, date: 1 });
  await col.meta.replaceOne({ _id: 'data_sources' }, {
    _id: 'data_sources',
    value: {
      catalog: { source: catalog.source, license: catalog.license, fetchedAt: catalog.fetchedAt, url: catalog.url },
      sales: { source: patterns.source, license: patterns.license, fetchedAt: patterns.fetchedAt, url: patterns.url, mapping: 'rank-by-price → UCI rank; category baselines; see DATA.md' },
      note: 'Real retail stand-in until owner data imported via npm run import:orders',
    },
  }, { upsert: true });

  let tiger: any = { status: 'skipped' };
  try {
    const t = await ensureTiger();
    if (t.ok) {
      await syncCatalogToTiger(products);
      await syncSalesToTiger(sales);
      tiger = { status: 'synced', detail: t.detail };
    } else tiger = { status: 'fallback', detail: t.detail };
  } catch (e: any) { tiger = { status: 'fallback', detail: e.message }; }

  return { products: products.length, customers: customers.length, suppliers: suppliers.length, sales: sales.length, tiger };
}

if (import.meta.main) {
  await client.connect();
  console.log('seeded real', await seed());
  await client.close();
}
