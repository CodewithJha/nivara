import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalogPath = fileURLToPath(new URL('../data/real/products.json', import.meta.url));
const uciPath = fileURLToPath(new URL('../data/real/uci-patterns.json', import.meta.url));

test('real catalog cache exists, has OFF origin, no noise brands', () => {
  assert.ok(existsSync(catalogPath));
  const doc = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.match(doc.license, /ODbL/i);
  assert.ok(doc.products.length >= 8);
  for (const p of doc.products) {
    assert.equal(p.origin.source, 'openfoodfacts');
    assert.ok(p.origin.code);
    assert.ok(p.price > 0 && p.stock >= 0);
    assert.doesNotMatch(p.name, /bournvita|chyawanprash|horlicks/i);
  }
});

test('UCI patterns cache is CC BY 4.0 with 90-day series', () => {
  assert.ok(existsSync(uciPath));
  const doc = JSON.parse(readFileSync(uciPath, 'utf8'));
  assert.match(doc.license, /CC BY 4\.0/);
  assert.ok(doc.patterns.length >= 10);
  assert.equal(doc.patterns[0].daily.length, 90);
});
