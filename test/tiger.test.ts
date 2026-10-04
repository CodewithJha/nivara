import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anomalyFlags } from '../src/ops.ts';
import { keywordRoute, templateAnswer } from '../src/agent.ts';

test('anomalyFlags marks spikes ≥ mean+2σ', () => {
  const daily = [1, 1, 1, 1, 1, 1, 1, 1, 1, 20];
  const flags = anomalyFlags(daily);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].index, 9);
  assert.ok(flags[0].z >= 2);
  assert.deepEqual(anomalyFlags([3, 3, 3, 3]), []);
});

test('keywordRoute sends constraint queries to search_catalog', () => {
  assert.equal(keywordRoute('protein under 1500 no sugar').tool, 'search_catalog');
  assert.equal(keywordRoute('find whey protein under ₹2000').tool, 'search_catalog');
  assert.equal(keywordRoute('cheaper supplier for whey').tool, 'search_supplier_prices');
});

test('catalog template lists hits without inventing SKUs beyond tool output', () => {
  const a = templateAnswer('search_catalog', {
    query: 'protein under 1500', mode: 'fts', source: 'tiger',
    filters: { maxPrice: 1500, noSugar: false },
    hits: [{ sku: 'R03', name: 'Protein Bar', category: 'bars', price: 95, sugarPer100g: 2, demand7: 12 }],
  });
  assert.match(a, /^1 product matches under ₹1,500\.\n• Protein Bar · ₹95 · 2 g sugar per 100 g · about 12 sold a week$/);
  assert.doesNotMatch(a, /R03|fts|tiger|\(/i);
  // hits over the price cap are never listed; tiny demand is not shown as "0.3 sold"
  const b = templateAnswer('search_catalog', { query: 'whey under 3000', mode: 'hybrid-fts+pgvector', filters: { q: 'whey', maxPrice: 3000 },
    hits: [{ sku: 'R1', name: 'Biozyme Whey', price: 4899, demand7: 0.3 }, { sku: 'R2', name: 'Whey', price: 2599, demand7: 0.3 }] });
  assert.equal(b, '1 product matches under ₹3,000.\n• Whey · ₹2,599 · about 1 sold a week');
});

test('shop_pulse template: plain overview by product name, no store names or proxy notes', () => {
  const a = templateAnswer('shop_pulse', {
    atlas: { pendingOrders: 2, overdue: 1, catalogSkus: 10, preferences: 1 },
    tiger: { skusWithDemand: 8, topDemand7: [{ sku: 'R01', name: 'Whey', demand7: 12.4 }] },
  });
  assert.match(a, /^You have 2 pending orders, 1 overdue\./);
  assert.match(a, /Selling fastest: Whey, about 12 a week/);
  assert.doesNotMatch(a, /Atlas|Tiger|proxy|R01|SKU/);
});
