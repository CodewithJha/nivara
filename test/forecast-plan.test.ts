// The stock plan (Next 7 days, cover, risk, reorder) follows the forecast, not last week's realised sales.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'nivara_test_forecast_plan';
process.env.LOG_LEVEL = 'silent';
const { client, col, today } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';
after(async () => { if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

test('cached forecast: plan uses forecast7, realised sales stay separate', { skip }, async () => {
  await col.forecasts.deleteMany({});
  await col.forecasts.insertOne({ date: today(), method: 'tabpfn', createdAt: new Date(), items: [
    // realised 5.9 last week, forecast 7.8 next week, 5 on hand, delivery 4 days
    { sku: 'R02', name: 'Chyawanprash Awaleha', stock: 5, reserved: 0, leadTimeDays: 4, last7Sold: 5.88, forecast7: 7.8, demand7: 5.9 },
  ] });
  const f = await ops.forecastDemand();
  const i = f.items[0];
  assert.equal(i.demand7, 7.8);
  assert.equal(i.daysOfCover, 4.5);
  assert.equal(i.risk, 'medium');
  assert.equal(i.reorderQty, 11); // 7.8/7 × (4 + 7 + 3) − 5
});
