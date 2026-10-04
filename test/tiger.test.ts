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
  assert.match(a, /Protein Bar \(R03\) — ₹95/);
  assert.match(a, /sugar 2g\/100g/);
});

test('shop_pulse template mentions Atlas and Tiger proxy note', () => {
  const a = templateAnswer('shop_pulse', {
    atlas: { pendingOrders: 2, overdue: 1, catalogSkus: 10, preferences: 1 },
    tiger: { skusWithDemand: 8, topDemand7: [{ sku: 'R01', demand7: 12 }], note: 'Demand: search-interest proxy, not real sales' },
  });
  assert.match(a, /Atlas/);
  assert.match(a, /Tiger/);
  assert.match(a, /proxy/);
});
