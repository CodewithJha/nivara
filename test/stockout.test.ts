import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockPlan } from '../src/logic.ts';

test('high risk when cover is shorter than supplier lead time', () => {
  const r = stockPlan({ stock: 6, reserved: 0, demand7: 14, leadTimeDays: 5 }); // 3 days cover
  assert.equal(r.risk, 'high');
  assert.equal(r.daysOfCover, 3);
});

test('medium risk when it runs out within a week but after lead time', () => {
  assert.equal(stockPlan({ stock: 10, reserved: 0, demand7: 14, leadTimeDays: 2 }).risk, 'medium');
});

test('low risk with > 7 days cover; no sales means infinite cover', () => {
  assert.equal(stockPlan({ stock: 100, reserved: 0, demand7: 14, leadTimeDays: 3 }).risk, 'low');
  const idle = stockPlan({ stock: 5, reserved: 0, demand7: 0, leadTimeDays: 3 });
  assert.equal(idle.risk, 'low');
  assert.equal(idle.daysOfCover, null);
});

test('over-committed stock is always high risk', () => {
  assert.equal(stockPlan({ stock: 3, reserved: 5, demand7: 0, leadTimeDays: 3 }).risk, 'high');
});
