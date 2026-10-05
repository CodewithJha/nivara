// Orders get short sequential numbers; older orders without one are numbered first, oldest first.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'nivara_test_order_no';
process.env.LOG_LEVEL = 'silent';
const { client, col } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';
after(async () => { if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

test('nextOrderNo numbers old orders by age, then counts on', { skip }, async () => {
  await col.orders.deleteMany({}); await col.meta.deleteMany({});
  const base = { customerId: 'C1', customerName: 'A', items: [], total: 0, status: 'pending', deliveryDate: null, source: 't' } as any;
  await col.orders.insertMany([{ ...base, _id: 'OB', createdAt: new Date('2026-10-02') }, { ...base, _id: 'OA', createdAt: new Date('2026-10-01') }]);
  assert.equal(await ops.nextOrderNo(), 3);
  assert.deepEqual((await col.orders.find().sort({ no: 1 }).toArray()).map(o => [o._id, o.no]), [['OA', 1], ['OB', 2]]);
  assert.equal(await ops.nextOrderNo(), 4);
});

