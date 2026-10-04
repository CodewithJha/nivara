import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movingAverage7, stockPlan } from '../src/logic.ts';

test('moving average uses last 14 days, scaled to a week', () => {
  assert.equal(movingAverage7([100, 100, ...Array(14).fill(2)]), 14);
  assert.equal(movingAverage7([]), 0);
  assert.equal(movingAverage7([1, 2]), 10.5);
});

test('reorder qty covers lead time + 7 days + safety, minus available', () => {
  // 2/day, lead 4, safety 3 → need 28, have 10 → 18
  assert.equal(stockPlan({ stock: 10, reserved: 0, demand7: 14, leadTimeDays: 4 }).reorderQty, 18);
  // reserved stock (pending orders) is not available
  assert.equal(stockPlan({ stock: 10, reserved: 4, demand7: 14, leadTimeDays: 4 }).reorderQty, 22);
  // plenty of stock → 0
  assert.equal(stockPlan({ stock: 500, reserved: 0, demand7: 14, leadTimeDays: 4 }).reorderQty, 0);
});

test('low risk never recommends a reorder (no topping up to target)', () => {
  // 10 days cover, 4-day lead → low; old rule would have said 28 - 20 = 8
  const r = stockPlan({ stock: 20, reserved: 0, demand7: 14, leadTimeDays: 4 });
  assert.equal(r.risk, 'low');
  assert.equal(r.reorderQty, 0);
});

// ---------- published TabPFN runs (hosts without Python) ----------
import { freshRun, mergeRunPred, tabpfnHealth, RUN_MAX_AGE_HOURS } from '../src/logic.ts';

test('published run is usable only while fresh and non-empty', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  assert.equal(freshRun({ pred: { A: 1 }, createdAt: '2026-10-04T10:00:00Z' }, now), true);
  assert.equal(freshRun({ pred: { A: 1 }, createdAt: new Date(now.getTime() - (RUN_MAX_AGE_HOURS + 1) * 36e5) }, now), false);
  assert.equal(freshRun({ pred: { A: 1 }, createdAt: '2026-10-04T10:00:00Z' }, now, 1), false);
  assert.equal(freshRun({ pred: {}, createdAt: '2026-10-04T10:00:00Z' }, now), false);
  assert.equal(freshRun({ pred: { A: 1 }, createdAt: 'not a date' }, now), false);
  assert.equal(freshRun(null, now), false);
});

test('run predictions used per SKU; uncovered or invalid SKUs fall back to moving average', () => {
  const s = Array(14).fill(2);
  const { pred, uncovered } = mergeRunPred({ A: s, B: s, C: s }, { A: 9.5, C: -1, Z: 3 } as any);
  assert.deepEqual(pred, { A: 9.5, B: 14, C: 14 });
  assert.deepEqual(uncovered, ['B', 'C']);
});

test('health: precomputed TabPFN is live with model + timestamp; moving average is fallback', () => {
  const at = '2026-10-04T15:00:00.000Z';
  const h = tabpfnHealth({ method: 'tabpfn', model: 'TabPFN v2', createdAt: new Date(), precomputed: { at, skus: 212, of: 212 } });
  assert.equal(h.status, 'live');
  assert.equal(h.mode, 'precomputed');
  assert.equal(h.model, 'TabPFN v2');
  assert.equal(h.at, at);
  assert.match(h.detail, /TabPFN v2 forecast precomputed 2026-10-04T15:00:00.000Z \(212\/212 products\)/);
  assert.equal(tabpfnHealth({ method: 'tabpfn', model: 'TabPFN v2', createdAt: at }).mode, 'live');
  assert.deepEqual(tabpfnHealth({ method: 'fallback-moving-average', fallbackReason: 'FORECAST_MODE=fallback' }), { status: 'fallback', detail: 'last forecast: fallback-moving-average (FORECAST_MODE=fallback)' });
  assert.deepEqual(tabpfnHealth(null), { status: 'fallback', detail: 'no forecast yet' });
});
