import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extraction, OrderInput, buildDraft, matchProduct, resolveDate } from '../src/logic.ts';

const products = [
  { _id: 'P01', name: 'Chocolate Protein Bar', aliases: ['choco bar', 'chocolate bar'], price: 90, stock: 40 },
  { _id: 'P05', name: 'Shaker Bottle 700ml', aliases: ['shaker'], price: 299, stock: 2 },
  { _id: 'P02', name: 'Peanut Butter Protein Bar', aliases: ['pb bar'], price: 95, stock: 30 },
];
const customers = [{ _id: 'C01', name: 'Rahul Verma' }];

test('extraction schema accepts word quantities and rejects junk', () => {
  const ok = Extraction.parse({ customer: 'Rahul', items: [{ product: 'chocolate bars', quantity: 3 }, { product: 'shaker', quantity: 'one' }], delivery_text: 'tomorrow' });
  assert.equal(ok.items[1].quantity, 1);
  assert.throws(() => Extraction.parse({ customer: 'Rahul', items: [] }));
  assert.throws(() => Extraction.parse({ customer: 'Rahul', items: [{ product: 'bar', quantity: -2 }] }));
  assert.throws(() => Extraction.parse({ items: [{ product: 'bar', quantity: 1 }] }));
});

test('confirm payload is strictly validated', () => {
  assert.throws(() => OrderInput.parse({ customerName: 'x', items: [{ sku: 'P01', quantity: 1.5 }] }));
  assert.throws(() => OrderInput.parse({ customerName: 'x', items: [{ sku: 'P01', quantity: 1 }], deliveryDate: 'tomorrow' }));
});

test('product matching handles plurals/aliases and refuses weak matches', () => {
  assert.equal(matchProduct('chocolate bars', products)?._id, 'P01');
  assert.equal(matchProduct('peanut butter bar', products)?._id, 'P02');
  assert.equal(matchProduct('yoga mat', products), null);
});

test('dates resolve deterministically', () => {
  const today = '2026-10-04'; // Sunday
  assert.equal(resolveDate('deliver tomorrow', today), '2026-10-05');
  assert.equal(resolveDate('day after tomorrow', today), '2026-10-06');
  assert.equal(resolveDate('on friday', today), '2026-10-09');
  assert.equal(resolveDate('sunday', today), '2026-10-11');
  assert.equal(resolveDate('in 3 days', today), '2026-10-07');
  assert.equal(resolveDate('12 oct', today), '2026-10-12');
  assert.equal(resolveDate('3 jan', today), '2027-01-03');
  assert.equal(resolveDate('31/02', today), null);
  assert.equal(resolveDate('sometime soon', today), null);
});

test('draft flags new customer, unknown product and short stock', () => {
  const ex = Extraction.parse({ customer: 'Rahul', items: [{ product: 'chocolate bars', quantity: 3 }, { product: 'shaker', quantity: 'three' }, { product: 'yoga mat', quantity: 1 }], delivery_text: 'tomorrow' });
  const d = buildDraft(ex, products, customers, '2026-10-04');
  assert.equal(d.customer.id, 'C01');
  assert.equal(d.deliveryDate, '2026-10-05');
  assert.equal(d.total, 3 * 90 + 3 * 299);
  assert.equal(d.problems.length, 2);
  const d2 = buildDraft(Extraction.parse({ customer: 'Neha', items: [{ product: 'pb bar', quantity: 1 }] }), products, customers, '2026-10-04');
  assert.ok(d2.customer.isNew);
});
