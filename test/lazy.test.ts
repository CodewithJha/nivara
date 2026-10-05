// public/lazy.js is a plain browser script; evaluate it in a vm context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx: any = {};
vm.runInNewContext(readFileSync(new URL('../public/lazy.js', import.meta.url), 'utf8') + '\nthis.nextSlices = nextSlices; this.progressive = progressive; this.LAZY = LAZY;', ctx);
const { nextSlices, progressive, LAZY } = ctx;
const plain = (x: any) => JSON.parse(JSON.stringify(x));

test('first batch stops at the budget, inside a group', () => {
  assert.deepEqual(plain(nextSlices([10, 202], { g: 0, r: 0 }, 30)), { parts: [{ g: 0, from: 0, to: 10 }, { g: 1, from: 0, to: 20 }], at: { g: 1, r: 20 } });
});

test('later batches continue where the last one stopped and end past the last group', () => {
  const counts = [10, 202];
  let at = { g: 0, r: 0 }, drawn = 0, batches = 0;
  while (at.g < counts.length) {
    const next = nextSlices(counts, at, 40);
    for (const p of next.parts) { assert.ok(p.from >= 0 && p.to <= counts[p.g]); drawn += p.to - p.from; }
    at = next.at; batches++;
  }
  assert.equal(drawn, 212);
  assert.equal(batches, 6);
});

test('a group that fits exactly moves the cursor to the next group', () => {
  assert.deepEqual(plain(nextSlices([30, 5], { g: 0, r: 0 }, 30)), { parts: [{ g: 0, from: 0, to: 30 }], at: { g: 1, r: 0 } });
});

test('empty groups still open so their empty message shows', () => {
  assert.deepEqual(plain(nextSlices([0, 3], { g: 0, r: 0 }, 30)).parts, [{ g: 0, from: 0, to: 0 }, { g: 1, from: 0, to: 3 }]);
});

test('progressive: short lists render whole, with no sentinel', () => {
  const html = progressive([{ rows: [1, 2, 3], row: (r: number) => `<tr>${r}</tr>`, html: (b: string, g: number) => `<tbody data-lazy="${g}">${b}</tbody>` }]);
  assert.equal(html, '<tbody data-lazy="0"><tr>1</tr><tr>2</tr><tr>3</tr></tbody>');
});

test('progressive: long lists render the first rows and a sentinel', () => {
  const rows = Array.from({ length: 212 }, (_, i) => i);
  const html = progressive([{ rows, row: (r: number) => `<tr>${r}</tr>`, html: (b: string) => `<t>${b}</t>` }]);
  assert.equal((html.match(/<tr>/g) ?? []).length, LAZY.first);
  assert.ok(html.endsWith('<div class="lazy-more" aria-hidden="true"></div>'));
});
