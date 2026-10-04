// Seed's sample-order step: data/samples/orders.csv through importOrders onto the real catalogue SKUs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.MONGODB_DB = 'nivara_test_seed_orders';
process.env.LOG_LEVEL = 'silent';
const { client, col } = await import('../src/db.ts');
const { importOrders } = await import('../scripts/import-orders.ts');
const { toShopProducts } = await import('../scripts/import/catalog.ts');
const { readJson } = await import('../scripts/import/http.ts');
const mongoOk = await client.connect().then(() => true, () => false);
after(async () => { if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

test('sample orders map onto real seeded SKUs with pending and delivered', { skip: !mongoOk && 'MongoDB not reachable' }, async () => {
  const catalog = readJson<{ products: any[] }>(fileURLToPath(new URL('../data/real/products.json', import.meta.url)))!.products;
  const products = toShopProducts(catalog, new Map()) as any[];
  await client.db(process.env.MONGODB_DB).dropDatabase();
  await col.products.insertMany(products);
  await col.customers.insertOne({ _id: 'C01', name: 'Rahul Verma', channel: 'whatsapp' });

  const r = await importOrders({ csvPath: fileURLToPath(new URL('../data/samples/orders.csv', import.meta.url)) });
  const orders = await col.orders.find().toArray();
  assert.equal(r.imported, 8);
  assert.equal(orders.length, 8);
  assert.ok(orders.some(o => o.status === 'pending') && orders.some(o => o.status === 'delivered'));
  const skus = new Set(products.map(p => p._id));
  assert.ok(orders.every(o => o.items.every(i => skus.has(i.sku))));
  assert.equal(orders.find(o => o.customerName === 'Rahul Verma')!.customerId, 'C01'); // existing customer reused
  assert.equal(orders.find(o => o.customerName === 'Kavya Iyer')!.items[0].name, 'Mulivitamin');
});
