// Daily brief cache: one Gemma call per day until an order or stock change invalidates it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.MONGODB_DB = 'nivara_test_brief';
process.env.LOG_LEVEL = 'silent';
process.env.FORECAST_MODE = 'fallback';
delete process.env.LLM_PROVIDER; delete process.env.TIGER_DATABASE_URL;

const { client, col } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const { app } = await import('../src/server.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';

const realFetch = globalThis.fetch;
let base = '', llmCalls = 0, server: any;
before(async () => {
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    if (url.startsWith(base)) return realFetch(u, init);
    if (url.includes('/v1/chat/completions')) {
      llmCalls++;
      assert.equal(JSON.parse(init.body).max_tokens, 160); // BRIEF_MAX_TOKENS default
      return Response.json({ choices: [{ message: { content: 'Restock whey today.' } }], usage: {} });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  if (mongoOk) {
    await client.db(process.env.MONGODB_DB).dropDatabase();
    await col.products.insertOne({ _id: 'R01', name: 'Whey Protein', aliases: ['whey'], category: 'powder', price: 2499, cost: 1780, stock: 10, supplierId: 'S3', leadTimeDays: 6 });
  }
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
after(async () => { globalThis.fetch = realFetch; server.close(); if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

const post = (path: string, body?: object) => realFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

test('brief is cached per day and rebuilt after order and stock changes', { skip }, async () => {
  const first = await ops.generateDailyBrief();
  assert.equal(first.by, 'template+gemma');
  assert.equal(llmCalls, 1);

  const again = await ops.generateDailyBrief();
  assert.equal(again.cached, true);
  assert.equal(String(again._id), String(first._id));
  assert.equal(llmCalls, 1);

  const order = await post('/api/orders', { customerName: 'Rahul Verma', items: [{ sku: 'R01', quantity: 2 }] });
  assert.equal(order.status, 201);
  const afterOrder = await ops.generateDailyBrief();
  assert.notEqual(afterOrder.cached, true);
  assert.match(afterOrder.text, /1 pending order/);
  assert.equal(llmCalls, 2);

  assert.equal((await post(`/api/orders/${(await order.json())._id}/deliver`)).status, 200);
  const afterDeliver = await ops.generateDailyBrief();
  assert.notEqual(afterDeliver.cached, true);
  assert.match(afterDeliver.text, /0 pending orders/);
  assert.equal(llmCalls, 3);

  const fresh = await ops.generateDailyBrief({ fresh: true });
  assert.notEqual(fresh.cached, true);
  assert.equal(llmCalls, 4);
});
