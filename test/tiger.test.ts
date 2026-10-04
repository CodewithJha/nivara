import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anomalyFlags } from '../src/ops.ts';
import { mapSales } from '../scripts/import-sales.ts';
import { keywordRoute, templateAnswer } from '../src/agent.ts';

test('anomalyFlags marks spikes ≥ mean+2σ', () => {
  const daily = [1, 1, 1, 1, 1, 1, 1, 1, 1, 20];
  const flags = anomalyFlags(daily);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].index, 9);
  assert.ok(flags[0].z >= 2);
  assert.deepEqual(anomalyFlags([3, 3, 3, 3]), []);
});

test('UCI mapSales is deterministic and category-scaled', () => {
  const products = [
    { _id: 'R01', name: 'Whey', aliases: [], category: 'powder', price: 2500, cost: 1800, stock: 5, supplierId: 'S3', leadTimeDays: 6 },
    { _id: 'R02', name: 'Bar', aliases: [], category: 'bars', price: 100, cost: 50, stock: 20, supplierId: 'S1', leadTimeDays: 4 },
  ];
  const patterns = [
    { daily: Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 10 : 2)), mean: 3.14 },
    { daily: Array.from({ length: 90 }, () => 5), mean: 5 },
  ];
  const a = mapSales(products as any, patterns, '2026-10-04');
  const b = mapSales(products as any, patterns, '2026-10-04');
  assert.equal(a.length, b.length);
  assert.deepEqual(a.slice(0, 3), b.slice(0, 3));
  assert.ok(a.every(s => s.sku === 'R01' || s.sku === 'R02'));
  assert.ok(a.every(s => s.date <= '2026-10-03'));
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
