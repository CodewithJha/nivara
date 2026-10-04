import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, bestQuote, orderFlag } from '../src/logic.ts';
import { keywordRoute } from '../src/agent.ts';

test('order flags: overdue, today, tomorrow, missing date; later = no action', () => {
  const t = '2026-10-04';
  assert.equal(orderFlag('2026-10-03', t), 'overdue');
  assert.equal(orderFlag('2026-10-04', t), 'due today');
  assert.equal(orderFlag('2026-10-05', t), 'due tomorrow');
  assert.equal(orderFlag(null, t), 'no delivery date');
  assert.equal(orderFlag('2026-10-06', t), null);
});

test('attention count = high-risk products + flagged orders + significant supplier savings only', () => {
  const a = attention(
    [{ risk: 'high' }, { risk: 'high' }, { risk: 'medium' }, { risk: 'low' }],
    [{ deliveryDate: '2026-10-03' }, { deliveryDate: '2026-10-04' }, { deliveryDate: '2026-10-09' }],
    [{ significant: true }, { significant: true }, { significant: false }],
    '2026-10-04',
  );
  assert.deepEqual(a, { total: 6, highRisk: 2, orders: 2, suppliers: 2 });
});

// defaults: ₹10 AND 5%
const q = (unitCost: number, blocked = false) => ({ supplier: 'X', unitCost, blocked });
test('supplier saving: meaningful saving counts, with ₹ and % reported', () => {
  assert.deepEqual(bestQuote(2150, [q(2013)]), { best: q(2013), savingPerUnit: 137, savingPercent: 6.4, significant: true });
});
test('supplier saving: ₹1 on a ₹52 bar is insignificant', () => {
  assert.equal(bestQuote(52, [q(51)])?.significant, false);
});
test('supplier saving: blocked supplier is ignored even when cheapest', () => {
  const r = bestQuote(310, [q(250, true), q(300)]);
  assert.equal(r?.best.unitCost, 300);
  assert.equal(r?.significant, false); // ₹10 but 3.2%
  assert.equal(bestQuote(310, [q(250, true)]), null);
});
test('supplier saving: zero / negative / non-numeric prices and costs are ignored', () => {
  assert.equal(bestQuote(100, [q(0), q(-5), q(NaN), q(Infinity)]), null);
  assert.equal(bestQuote(0, [q(50)]), null);
  assert.equal(bestQuote(NaN, [q(50)]), null);
});
test('supplier saving: ₹15 off ₹1,780 passes ₹ threshold but fails % threshold', () => {
  const r = bestQuote(1780, [q(1765)]);
  assert.equal(r?.savingPercent, 0.8);
  assert.equal(r?.significant, false);
});
test('supplier saving: 8.9% off a ₹56 bar passes % threshold but fails ₹ threshold', () => {
  const r = bestQuote(56, [q(51)]);
  assert.equal(r?.savingPerUnit, 5);
  assert.equal(r?.significant, false);
});

test('dashboard suggestion chips route to sensible tools without Gemma', () => {
  assert.equal(keywordRoute('What should I restock?').tool, 'get_inventory');
  assert.equal(keywordRoute('Why is this product at risk?').tool, 'forecast_demand');
  assert.equal(keywordRoute('Show my pending orders.').tool, 'get_pending_orders');
  assert.equal(keywordRoute('What sold the most?').tool, 'get_sales_summary');
  assert.equal(keywordRoute('What should I focus on today?').tool, 'generate_daily_brief');
});
