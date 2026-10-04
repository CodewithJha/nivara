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
