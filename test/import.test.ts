import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productType, MANUAL_PRICE } from '../scripts/import/config.ts';
import { mapCatalog, toShopProducts } from '../scripts/import/catalog.ts';
import { indexPrices } from '../scripts/import/prices.ts';
import { parseTimeline } from '../scripts/import/trends.ts';
import { weeklyDemand, expandWeeklyToDaily, skuShare, recentDaily } from '../scripts/import/demand.ts';

const fixtureProducts = [
  { code: '8901', product_name: 'Whey Protein Isolate', brands: 'MuscleBlaze', categories_tags: ['en:protein-powders'], quantity: '1 kg' },
  { code: '8902', product_name: 'Creatine Monohydrate', brands: 'ON', categories_tags: ['en:bodybuilding-supplements'], quantity: '250 g' },
  { code: '8903', product_name: 'Bournvita', brands: 'Cadbury', categories_tags: ['en:dietary-supplements'], quantity: '500 g' }, // filtered out — no keep match on "protein|..." wait Bournvita doesn't match KEEP_RE
];

test('catalog maps OFF rows, filters noise, assigns productType', () => {
  const cat = mapCatalog(fixtureProducts);
  assert.equal(cat.length, 2);
  assert.equal(cat[0].productType, 'whey');
  assert.equal(cat[1].productType, 'creatine');
  assert.ok(!cat.some(p => /bournvita/i.test(p.name)));
});

test('prices join by code; missing → manual estimate by productType', () => {
  const byCode = indexPrices([
    { product_code: '8901', price: 2200, date: '2026-09-01', location: { city: 'Delhi' } },
    { product_code: '8901', price: 2100, date: '2026-10-01', location: { city: 'Mumbai' } }, // newer wins
  ]);
  assert.equal(byCode.get('8901'), 2100);
  const shop = toShopProducts(mapCatalog(fixtureProducts), byCode);
  assert.equal(shop.find(p => p.origin.code === '8901')!.priceSource, 'open-prices');
  assert.equal(shop.find(p => p.origin.code === '8901')!.price, 2100);
  const creatine = shop.find(p => p.origin.code === '8902')!;
  assert.equal(creatine.priceSource, 'manual');
  assert.equal(creatine.price, MANUAL_PRICE.creatine);
});

test('trends parseTimeline drops partial last week', () => {
  const pts = parseTimeline([
    { date: '2026-09-14', values: [{ extracted_value: 40 }] },
    { date: '2026-09-21', values: [{ extracted_value: 50 }] },
    { date: '2026-09-28', values: [{ extracted_value: 10 }] }, // dropped
  ], 'whey');
  assert.equal(pts.length, 2);
  assert.equal(pts.at(-1)!.week, '2026-09-21');
});

test('proxy demand = trends × share; every row source proxy', () => {
  const cat = mapCatalog(fixtureProducts);
  const trends = [
    { productType: 'whey' as const, week: '2026-09-14', value: 100 },
    { productType: 'creatine' as const, week: '2026-09-14', value: 50 },
  ];
  const weekly = weeklyDemand(cat, trends);
  assert.ok(weekly.every(w => w.qty > 0));
  const share = skuShare(cat);
  assert.equal(share.get(cat[0]._id), 1); // one whey
  const daily = expandWeeklyToDaily(weekly);
  assert.ok(daily.every(d => d.source === 'proxy'));
  assert.equal(daily.filter(d => d.sku === cat[0]._id).length, 7);
  assert.equal(recentDaily(daily, 3).length, 3 * cat.length); // 3 days × 2 skus
});

test('proxy demand scales to the shop weekly total and keeps the trends shape', () => {
  const cat = mapCatalog(fixtureProducts);
  const trends = [
    { productType: 'whey' as const, week: '2026-09-14', value: 40 },
    { productType: 'whey' as const, week: '2026-09-21', value: 80 },
    { productType: 'creatine' as const, week: '2026-09-14', value: 50 },
    { productType: 'creatine' as const, week: '2026-09-21', value: 100 },
  ];
  const weekly = weeklyDemand(cat, trends, 200);
  const total = (w: string) => weekly.filter(r => r.week === w).reduce((a, r) => a + r.qty, 0);
  assert.ok(Math.abs((total('2026-09-14') + total('2026-09-21')) / 2 - 200) < 0.1);
  assert.ok(Math.abs(total('2026-09-21') / total('2026-09-14') - 2) < 0.01); // trends doubled → demand doubled
  assert.ok(Math.abs(weeklyDemand(cat, trends, 50).reduce((a, r) => a + r.qty, 0) / 2 - 50) < 0.1);
});

test('productType classifier', () => {
  assert.equal(productType('Pre-Workout Fruit Punch'), 'preworkout');
  assert.equal(productType('Omega-3 Fish Oil'), 'omega');
  assert.equal(productType('Chyawanprash'), 'ayurvedic');
});
