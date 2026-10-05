import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePack, packFor, profileFor, roundIndian, estimatePrice, type EstimateInput } from '../scripts/import/price-estimate.ts';
import { PROFILES } from '../scripts/import/pricing.config.ts';

const catalog: EstimateInput[] = JSON.parse(readFileSync(new URL('../data/real/products.json', import.meta.url), 'utf8')).products;
const est = (name: string, productType: EstimateInput['productType'], quantity = '', brands = '', code = name) =>
  estimatePrice({ code, name, brands, quantity, productType });
const isIndianEnding = (p: number) => (p < 200 ? p % 10 === 9 : p % 50 === 49);

test('parsePack: mass, count, imperial, multipacks, servings, bare numbers', () => {
  assert.deepEqual(parsePack('1.75kg'), { grams: 1750 });
  assert.equal(parsePack('2 lb (909 g)').grams, 453.6 * 2);
  assert.equal(parsePack('Net Quantityt: 1kg').grams, 1000);
  assert.equal(parsePack('500gm').grams, 500);
  assert.equal(parsePack('200ml').grams, 200);
  assert.equal(parsePack('6 bars, 50g each').grams, 300);
  assert.equal(parsePack('60 capsules').count, 60);
  assert.equal(parsePack('90 Softgel').count, 90);
  assert.equal(parsePack('180 N').count, 180);
  assert.deepEqual(parsePack('500g 14 servings'), { grams: 500, servings: 14 });
  assert.deepEqual(parsePack('950'), { bare: 950 });
  assert.deepEqual(parsePack(''), {});
});

test('packFor: converts bases, falls back to the default for missing or implausible packs', () => {
  assert.deepEqual(packFor(PROFILES.whey, {}), { amount: 1000, unit: 'g', source: 'default' });
  assert.deepEqual(packFor(PROFILES.ayurvedic, { bare: 950 }), { amount: 950, unit: 'g', source: 'quantity' });
  assert.deepEqual(packFor(PROFILES.omega, { grams: 1 }), { amount: 60, unit: 'units', source: 'default' }); // "1000 mg" is capsule strength
  assert.equal(packFor(PROFILES.omega, { grams: 165 }).amount, 118); // 165 g of 1.4 g softgels
  assert.equal(packFor(PROFILES.whey, { servings: 30 }).amount, 990);
});

test('profileFor: retail form inside whey (bars, RTD, oats, gainer); powders stay whey', () => {
  assert.equal(profileFor({ name: 'Peanut Butter Protein Bar', productType: 'whey' }), 'protein_bar');
  assert.equal(profileFor({ name: 'Yoga bar High Protein Muesli+', productType: 'whey' }), 'protein_oats');
  assert.equal(profileFor({ name: 'Turbo Protein Milkshake', productType: 'whey' }, { grams: 200 }), 'protein_rtd');
  assert.equal(profileFor({ name: 'Plant Protein Shake', productType: 'whey' }, { grams: 1000 }), 'whey');
  assert.equal(profileFor({ name: 'Advanced Mass And Weight Gainer', productType: 'whey' }), 'gainer');
  assert.equal(profileFor({ name: 'Creatine Monohydrate', productType: 'creatine' }), 'creatine');
});

test('roundIndian: …9 under ₹200, …49/…99 above', () => {
  assert.equal(roundIndian(45), 49);
  assert.equal(roundIndian(72), 69);
  assert.equal(roundIndian(1830), 1849);
  assert.equal(roundIndian(2480), 2499);
});

test('estimates land in realistic Indian MRP ranges', () => {
  const inRange = (p: number, lo: number, hi: number) => assert.ok(p >= lo && p <= hi, `${p} not in ₹${lo}-${hi}`);
  inRange(est('Protein Bar', 'whey', '50g').price, 40, 120);
  inRange(est('Whey Protein', 'whey', '1 kg').price, 1800, 3500);
  inRange(est('Creatine Monohydrate', 'creatine', '250g').price, 500, 1200);
  inRange(est('Multivitamin', 'multivitamin', '60 tablets').price, 300, 900);
  inRange(est('Omega 3', 'omega', '60 capsules').price, 400, 1200);
  inRange(est('Chyawanprash', 'ayurvedic', '500 g').price, 199, 450);
  inRange(est('Chyawanprash', 'ayurvedic', '1 kg').price, 199, 450);
  inRange(est('Pre-workout', 'preworkout', '300g').price, 900, 2500);
  assert.ok(est('Whey Protein', 'whey', '2.27 kg').price > est('Whey Protein', 'whey', '1 kg').price);
});

test('powders: a serving weight from OFF is not the tub size (Biozyme Performance Whey was ₹139)', () => {
  const tub = est('Biozyme Performance Whey', 'whey', '1 piece, 36g', 'Muscleblaze');
  assert.equal(tub.profile, 'whey');
  assert.deepEqual(tub.pack, { amount: 1000, unit: 'g', source: 'default' });
  assert.ok(tub.price >= 1000 && tub.price <= 6000, `₹${tub.price}`);
  for (const q of ['30g', '25g', '35 g', '100']) assert.ok(est('Whey Protein Isolate', 'whey', q).price >= 1000, q);
  assert.ok(est('Plant Protein', 'whey', '200g').price < est('Plant Protein', 'whey', '1 kg').price); // real small tubs still scale down
  // every powder in the real catalogue prices like a tub, not a sachet
  for (const p of catalog) { const e = estimatePrice(p); if (e.profile === 'whey') assert.ok(e.price >= 399, `${p.name}: ₹${e.price}`); }
});

test('form: OFF categories mark a bar the name does not (High Protein Peanut Cocoa, en:protein-bars)', () => {
  const e = estimatePrice({ code: 'x', name: 'The Whole Truth High Protein Peanut Cocoa', brands: 'The Whole Truth', quantity: '67g', productType: 'whey', categories: ['en:protein-bars'] });
  assert.equal(e.profile, 'protein_bar');
  assert.ok(e.price < 200);
  assert.equal(profileFor({ name: 'Cocoa Whey Protein', productType: 'whey', categories: ['en:protein-powders', 'en:whey-powder'] }), 'whey');
});

test('brand tier: premium brands sit above value brands for the same pack', () => {
  const premium = est('Gold Standard 100% Whey', 'whey', '1 kg', 'Optimum Nutrition', 'a');
  const value = est('Whey Protein', 'whey', '1 kg', 'Nakpro', 'a');
  assert.equal(premium.tier, 'premium');
  assert.equal(value.tier, 'value');
  assert.ok(premium.price > value.price);
});

test('deterministic: same code → same price and cost; cost inside margin band', () => {
  for (const p of catalog.slice(0, 40)) assert.deepEqual(estimatePrice(p), estimatePrice(p));
  for (const p of catalog) {
    const e = estimatePrice(p);
    const [lo, hi] = PROFILES[e.profile].clamp;
    assert.ok(e.price >= lo && e.price <= hi, `${p.name}: ${e.price}`);
    assert.ok(isIndianEnding(e.price), `${p.name}: ₹${e.price} ending`);
    assert.ok(e.cost < e.price && e.cost / e.price > 0.55, `${p.name}: cost ${e.cost} / ${e.price}`);
  }
});

test('real catalogue: prices spread instead of one price per productType', () => {
  const byType = new Map<string, Set<number>>();
  for (const p of catalog) {
    const s = byType.get(p.productType) ?? new Set<number>();
    s.add(estimatePrice(p).price);
    byType.set(p.productType, s);
  }
  for (const [type, prices] of byType) {
    const n = catalog.filter(p => p.productType === type).length;
    if (n >= 5) assert.ok(prices.size >= Math.min(3, n), `${type}: only ${prices.size} distinct prices`);
  }
  assert.ok(byType.get('whey')!.size >= 30);
  // No single price dominates the catalogue (was 159 whey rows at ₹2,499).
  const counts = new Map<number, number>();
  for (const p of catalog) { const v = estimatePrice(p).price; counts.set(v, (counts.get(v) ?? 0) + 1); }
  assert.ok(Math.max(...counts.values()) <= catalog.length * 0.1);
});
