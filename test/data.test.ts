import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const trendsPath = fileURLToPath(new URL('../data/raw/trends_in.csv', import.meta.url));

test('trends cache exists with productType,week,value', () => {
  assert.ok(existsSync(trendsPath));
  const lines = readFileSync(trendsPath, 'utf8').trim().split('\n');
  assert.match(lines[0], /productType/);
  assert.ok(lines.length > 10);
});

test('DATA.md documents ODbL sources and proxy demand label', () => {
  const md = readFileSync(fileURLToPath(new URL('../docs/DATA.md', import.meta.url)), 'utf8');
  assert.match(md, /Open Food Facts/);
  assert.match(md, /Open Prices/);
  assert.match(md, /2026-10-04/);
  assert.match(md, /search-interest proxy/);
  assert.doesNotMatch(md, /UCI Online Retail/);
});
