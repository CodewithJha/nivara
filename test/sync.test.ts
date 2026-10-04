import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports: static ones are hoisted above this line and db.ts would bind to the real 'nivara' DB.
process.env.MONGODB_DB = 'nivara_test_sync';
process.env.LOG_LEVEL = 'silent';
const { orderToLines, upsertOrderLines } = await import('../src/sync.ts');
const { shopPulse, keywordRoute } = await import('../src/agent.ts');
const { ensureTiger, poolForSync } = await import('../src/tiger.ts');
const { client, col } = await import('../src/db.ts');

after(async () => {
  try { await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); } catch { /* ok */ }
  try { await poolForSync()?.end(); } catch { /* ok */ }
});

test('orderToLines expands delivered order items', () => {
  const lines = orderToLines({
    _id: 'OTEST1',
    items: [{ sku: 'R01', name: 'Whey', quantity: 2, price: 100 }, { sku: 'R02', name: 'Creatine', quantity: 1, price: 50 }],
    deliveredAt: '2026-10-04T10:00:00Z',
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { orderId: 'OTEST1', sku: 'R01', day: '2026-10-04', qty: 2 });
});

test('upsertOrderLines is idempotent by orderId+sku', async () => {
  const st = await ensureTiger();
  if (!st.ok) return; // skip when Tiger unset in CI
  const lines = orderToLines({
    _id: 'OIDEM-' + Date.now(),
    items: [{ sku: 'R99', name: 'Test', quantity: 3, price: 1 }],
    deliveredAt: '2026-10-04T12:00:00Z',
  });
  const a = await upsertOrderLines(lines);
  const b = await upsertOrderLines(lines);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.upserted, 1);
  assert.equal(b.upserted, 1); // same keys, no double-count delta (qty unchanged)
});

test('keywordRoute sends combined questions to shop_pulse', () => {
  assert.equal(keywordRoute("how's the business looking").tool, 'shop_pulse');
  assert.equal(keywordRoute('ops and demand together').tool, 'shop_pulse');
});

test('shopPulse fetches Atlas + Tiger in parallel', async () => {
  const mongoOk = await client.connect().then(() => true, () => false);
  if (!mongoOk) return;
  await col.products.deleteMany({});
  await col.products.insertOne({ _id: 'R01', name: 'Whey', aliases: [], category: 'powder', price: 100, cost: 70, stock: 5, supplierId: 'S1', leadTimeDays: 4 });
  await col.orders.deleteMany({});
  const out = await shopPulse();
  assert.equal(out.fetched, 'parallel');
  assert.equal(out.atlas.store, 'atlas');
  assert.equal(out.tiger.store, 'tiger');
  assert.ok(out.atlas.catalogSkus >= 1);
  assert.match(out.tiger.note, /proxy/i);
});
