import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toShopProducts } from '../scripts/import/catalog.ts';
import { indexPrices } from '../scripts/import/prices.ts';
import { buildSuppliers, quoteFor } from '../scripts/import/supplier-quotes.ts';
import { SUPPLIERS } from '../scripts/import/suppliers.config.ts';
import { bestQuote } from '../src/logic.ts';

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const products = toShopProducts(json('../data/real/products.json').products, indexPrices(json('../data/raw/open_prices_inr.json').items));
const suppliers = buildSuppliers(products);
const costOf = new Map(products.map(p => [p._id, p.cost]));

/** Same logic as ops.supplierOpportunities, without Mongo. */
function opportunities() {
  return products.flatMap(p => {
    const quotes = suppliers.filter(s => s._id !== p.supplierId)
      .flatMap(s => s.quotes.filter(q => q.sku === p._id).map(q => ({ supplier: s.name, unitCost: q.unitCost, blocked: false })));
    const q = bestQuote(p.cost, quotes);
    return q ? [{ sku: p._id, ...q }] : [];
  });
}

test('each supplier quotes only a subset, never its own products', () => {
  for (const s of suppliers) {
    assert.ok(s.quotes.length > 0 && s.quotes.length < products.length * 0.7, `${s._id}: ${s.quotes.length} quotes`);
    const own = new Set(products.filter(p => p.supplierId === s._id).map(p => p._id));
    assert.ok(!s.quotes.some(q => own.has(q.sku)));
  }
});

test('most quotes sit within ±5% of current cost; deals stay within 8–15%', () => {
  const ratios = suppliers.flatMap(s => s.quotes.map(q => q.unitCost / costOf.get(q.sku)!));
  const near = ratios.filter(r => r >= 0.94 && r <= 1.06).length;
  assert.ok(near / ratios.length >= 0.85, `${near}/${ratios.length} near current cost`);
  assert.ok(ratios.every(r => r >= 0.84 && r <= 1.07), 'no implausible quote');
});

test('opportunities: a small believable number, with varied savings', () => {
  const opp = opportunities(), sig = opp.filter(o => o.significant);
  assert.ok(sig.length >= 5 && sig.length <= 20, `${sig.length} significant opportunities`);
  assert.ok(opp.length <= 30, `${opp.length} cheaper quotes in total`);
  assert.ok(new Set(sig.map(o => o.savingPerUnit)).size >= Math.min(5, sig.length), 'savings are not one repeated amount');
  assert.ok(sig.every(o => o.savingPercent >= 5 && o.savingPercent <= 16));
});

test('Supplier C is cheaper on average but slower', () => {
  const mean = (id: string, f: (q: { sku: string; unitCost: number; leadTimeDays: number }) => number) => {
    const qs = suppliers.find(s => s._id === id)!.quotes;
    return qs.reduce((a, q) => a + f(q), 0) / qs.length;
  };
  const ratio = (id: string) => mean(id, q => q.unitCost / costOf.get(q.sku)!);
  const lead = (id: string) => mean(id, q => q.leadTimeDays);
  for (const id of ['S1', 'S2', 'S3']) {
    assert.ok(ratio('S4') < ratio(id), `S4 ${ratio('S4')} vs ${id} ${ratio(id)}`);
    assert.ok(lead('S4') > lead(id));
  }
});

test('deterministic: rebuilding gives identical quotes', () => {
  assert.deepEqual(buildSuppliers(products), suppliers);
  const p = { _id: 'X1', cost: 1000, supplierId: 'S1' };
  assert.deepEqual(quoteFor(SUPPLIERS[1], p), quoteFor(SUPPLIERS[1], p));
  assert.equal(quoteFor(SUPPLIERS[0], p), null); // own supplier
  assert.ok(suppliers.every(s => !('quoting' in s)), 'config not persisted into supplier docs');
});
