// forecastDemand on a host without TabPFN reuses the newest fresh published run (throwaway Mongo DB).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGODB_DB = 'nivara_test_forecast_run';
process.env.LOG_LEVEL = 'silent';
process.env.FORECAST_MODE = 'fallback'; // like Render: no Python
delete process.env.TIGER_DATABASE_URL;
const LOG = join(tmpdir(), `fake-tabpfn-${process.pid}.log`);
process.env.TABPFN_PYTHON = fileURLToPath(new URL('./fixtures/fake-tabpfn.mjs', import.meta.url));
process.env.FAKE_TABPFN_LOG = LOG;

const { client, col, today, daysAgo } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';

const run = (hoursAgo: number, pred: Record<string, number>) => col.forecastRuns.insertOne({ source: 'tabpfn', model: 'TabPFN v2', package: 'tabpfn test', asOf: today(), historyDays: 60, skus: Object.keys(pred).length, of: 2, pred, createdAt: new Date(Date.now() - hoursAgo * 36e5) });

before(async () => { if (mongoOk) await client.db().dropDatabase(); });
beforeEach(async () => {
  if (!mongoOk) return;
  for (const c of ['products', 'sales', 'forecasts', 'forecastRuns', 'orders'] as const) await col[c].deleteMany({});
  await col.products.insertMany([
    { _id: 'A', name: 'Whey A', aliases: [], category: 'powder', price: 100, cost: 80, stock: 3, supplierId: 'S1', leadTimeDays: 5 },
    { _id: 'B', name: 'Bar B', aliases: [], category: 'bar', price: 50, cost: 30, stock: 100, supplierId: 'S1', leadTimeDays: 2 },
  ]);
  await col.sales.insertMany([1, 2, 3, 4, 5, 6, 7].flatMap(d => [{ sku: 'A', date: daysAgo(d), qty: 1 }, { sku: 'B', date: daysAgo(d), qty: 2 }]));
});
after(async () => { rmSync(LOG, { force: true }); if (mongoOk) await client.db().dropDatabase(); await client.close(); });

test('no published run → labelled moving-average fallback', { skip }, async () => {
  const f = await ops.forecastDemand({ force: true });
  assert.equal(f.method, 'fallback-moving-average');
  assert.equal(f.precomputed, undefined);
});

test('fresh published run → method tabpfn, precomputed, its predictions drive the stock plan', { skip }, async () => {
  await run(30, { A: 21, B: 3 }); // older
  const { insertedId } = await run(2, { A: 14 }); // newest; B uncovered
  const f = await ops.forecastDemand({ force: true });
  assert.equal(f.method, 'tabpfn');
  assert.equal(f.model, 'TabPFN v2');
  assert.deepEqual({ ...f.precomputed, at: undefined }, { runId: insertedId, at: undefined, asOf: today(), skus: 1, of: 2 });
  const a = f.items.find((i: any) => i.sku === 'A'), b = f.items.find((i: any) => i.sku === 'B');
  assert.equal(a.forecast7, 14);
  assert.equal(a.forecastMethod, undefined);
  assert.equal(a.risk, 'high'); // 3 in stock, 2/day, 5-day lead
  assert.equal(b.forecastMethod, 'moving-average');
  assert.equal(b.forecast7, 7); // moving average: 14 units over a 14-day window, × 7
});

test('stale published run is ignored', { skip }, async () => {
  await run(24 * 31, { A: 14, B: 14 });
  const f = await ops.forecastDemand({ force: true });
  assert.equal(f.method, 'fallback-moving-average');
  assert.match(f.fallbackReason, /stale/);
});

test('publish: runs TabPFN in chunks, stores one run, caches a precomputed tabpfn forecast', { skip }, async () => {
  delete process.env.FORECAST_MODE; // this machine can run it
  try {
    rmSync(LOG, { force: true });
    const r = await ops.publishForecastRun({ chunk: 1 });
    assert.equal(readFileSync(LOG, 'utf8'), '1\n1\n'); // one subprocess per chunk
    assert.deepEqual({ model: r.model, package: r.package, skus: r.skus, of: r.of }, { model: 'TabPFN stub', package: 'tabpfn fake', skus: 2, of: 2 });
    const run = await col.forecastRuns.findOne({ _id: r.runId });
    assert.deepEqual(run?.pred, { B: 14, A: 7 });
    const cached = await col.forecasts.findOne({ date: today() }, { sort: { createdAt: -1 } });
    assert.equal(cached?.method, 'tabpfn');
    assert.deepEqual(cached?.precomputed.runId, r.runId);
    const top1 = await ops.publishForecastRun({ top: 1 });
    assert.deepEqual(Object.keys((await col.forecastRuns.findOne({ _id: top1.runId }))!.pred), ['B']); // highest demand only
  } finally { process.env.FORECAST_MODE = 'fallback'; }
});
