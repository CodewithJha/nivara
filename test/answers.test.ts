import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStructured, templateAnswer } from '../src/agent.ts';
import { looksClean } from '../src/logic.ts';

const item = (o: any) => ({ sku: 'P01', name: 'Chocolate Protein Bar', stock: 18, reserved: 9, leadTimeDays: 4, last7Sold: 55, demand7: 41.8, available: 9, daysOfCover: 1.5, risk: 'high', reorderQty: 75, ...o });
const inv = { method: 'tabpfn', items: [item({}), item({ sku: 'P05', name: 'Shaker Bottle 700ml', stock: 12, reserved: 1, available: 11, demand7: 14.2, daysOfCover: 5.4, leadTimeDays: 3, risk: 'medium', reorderQty: 16 }), item({ sku: 'P11', name: 'Oats 1kg Rolled', stock: 40, reserved: 0, available: 40, demand7: 13.3, daysOfCover: 21, risk: 'low', reorderQty: 0 })] };
const JUNK = /demand7|reorderQty|daysOfCover|leadTimeDays|last7Sold|\bsku\b|\bP\d\d\b|Demand\d|undefined|NaN|null|\[object/;

const clean = (s: string) => { assert.doesNotMatch(s, JUNK); assert.ok(looksClean(s.replace(/×/g, 'x')), s); };

test('restock answer: plain sentences, integer demand, available vs in-stock explained, low-risk omitted', () => {
  const a = templateAnswer('get_inventory', inv);
  clean(a);
  assert.match(a, /Chocolate Protein Bar: order 75 units\. 9 units available to sell \(18 in stock, 9 reserved for pending orders\); about 42 units expected to sell in the next 7 days, so about 1\.5 days of stock vs a 4-day delivery time\./);
  assert.match(a, /Shaker Bottle 700ml: order 16 units/);
  assert.doesNotMatch(a, /Oats/);
  assert.match(a, /TabPFN forecast/);
});

test('risk answer focuses on the named product and explains cover vs lead time', () => {
  const a = templateAnswer('forecast_demand', inv, 'Chocolate Protein Bar');
  clean(a);
  assert.match(a, /^Chocolate Protein Bar is at high risk of running out\./);
  assert.match(a, /about 1\.5 days of stock, but a new delivery takes 4 days/);
  assert.match(a, /roughly 6 a day/);
  assert.match(a, /order 75 units now/);
  assert.doesNotMatch(a, /Shaker/);
  assert.match(templateAnswer('forecast_demand', inv, 'Oats 1kg Rolled'), /not at risk right now/);
  assert.match(templateAnswer('forecast_demand', inv), /^2 products could run out soon:/);
});

test('pending orders: customer, items, ₹ total with Indian grouping, due wording; no order ids', () => {
  const a = templateAnswer('get_pending_orders', { today: '2026-10-04', orders: [
    { _id: 'O004', customerName: 'Sneha Gupta', items: [{ quantity: 1, name: 'Pre-Workout 300g Fruit Punch' }, { quantity: 1, name: 'Gym Gloves' }], total: 1898, deliveryDate: '2026-10-03', overdue: true, dueToday: false, flag: 'overdue' },
    { _id: 'O002', customerName: 'Priya Singh', items: [{ quantity: 1, name: 'Whey Protein 1kg Chocolate' }], total: 102499, deliveryDate: '2026-10-04', overdue: false, dueToday: true, flag: 'due today' },
    { _id: 'O003', customerName: 'Aman Khan', items: [{ quantity: 4, name: 'Cookies & Cream Protein Bar' }], total: 570, deliveryDate: '2026-10-06', overdue: false, dueToday: false, flag: null },
  ] });
  clean(a);
  assert.match(a, /^You have 3 pending orders \(1 overdue\):/);
  assert.match(a, /Sneha Gupta: 1× Pre-Workout 300g Fruit Punch, 1× Gym Gloves · ₹1,898 · overdue \(was due 3 Oct\)/);
  assert.match(a, /₹1,02,499 · due today/);
  assert.match(a, /Aman Khan: .* · due 6 Oct/);
  assert.equal(templateAnswer('get_pending_orders', { orders: [] }), 'You have no pending orders.');
});

test('sales answer leads with the best seller sentence', () => {
  const a = templateAnswer('get_sales_summary', { since: '2026-09-27', days: 7, top: [{ sku: 'P01', name: 'Chocolate Protein Bar', qty: 55, revenue: 4950 }, { sku: 'P02', name: 'Peanut Butter Protein Bar', qty: 1, revenue: 95 }] });
  clean(a);
  assert.match(a, /^Your best-selling product over the last 7 days was Chocolate Protein Bar, with 55 units sold \(₹4,950\)\.\nNext best:\n• Peanut Butter Protein Bar: 1 unit \(₹95\)$/);
  assert.equal(templateAnswer('get_sales_summary', { days: 7, top: [] }), 'No sales recorded in the last 7 days.');
});

test('supplier answer states saving and threshold, never invents live prices', () => {
  const a = templateAnswer('search_supplier_prices', {
    product: { name: 'Chocolate Protein Bar', cost: 52, currentSupplier: 'FitFuel Distributors' }, query: 'Chocolate Protein Bar', threshold: { rupees: 10, percent: 5 },
    dbOpportunity: { best: { supplier: 'NutriHub India', unitCost: 51 }, savingPerUnit: 1, savingPercent: 1.9, significant: false, skippedBlocked: ['Supplier C (Sports Mart)'] },
    web: { available: false, reason: 'Live supplier search is not configured (no SerpApi key), so this uses only the supplier quotes stored in your database.', offers: [], hiddenBlocked: 0 }, cheapestWeb: null, memory: { recalled: [] },
  });
  assert.match(a, /saving ₹1 per unit \(1\.9%\)\. That is below your ₹10 and 5% threshold/);
  assert.match(a, /Skipped blocked supplier: Supplier C/);
  assert.match(a, /not configured/);
  assert.doesNotMatch(a, /Cheapest live/);
});

test('leak guard rejects field names and ids, accepts normal prose', () => {
  assert.equal(looksClean('Demand7: low risk'), false);
  assert.equal(looksClean('reorderQty is 75'), false);
  assert.equal(looksClean('days_of_cover 1.5'), false);
  assert.equal(looksClean('Order P01 now'), false);
  assert.equal(looksClean('Restock Whey Protein 1kg Chocolate today: about 11 units sell each week (₹2,499 each).'), true);
});

test('chip questions use templates; open-ended ones go to Gemma', () => {
  for (const q of ['What should I restock?', 'Why is this product at risk?', 'Show my pending orders.', 'What sold the most?', 'What should I focus on today?']) assert.equal(isStructured(q), true, q);
  assert.equal(isStructured('How is my business doing compared to last month?'), false);
});
