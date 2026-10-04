// public/plates.js is a plain browser script; evaluate it in a vm context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx: any = {};
vm.runInNewContext(readFileSync(new URL('../public/plates.js', import.meta.url), 'utf8') + '\nthis.loadPlates = loadPlates; this.MAX_PLATES = MAX_PLATES;', ctx);
const { loadPlates, MAX_PLATES } = ctx;
const jobs = (heavy: number, mid: number, light: number) => [
  ...Array.from({ length: heavy }, (_, i) => ({ level: 'heavy', to: 'h' + i })),
  ...Array.from({ length: mid }, (_, i) => ({ level: 'mid', to: 'm' + i })),
  ...Array.from({ length: light }, (_, i) => ({ level: 'light', to: 'l' + i })),
];
const tally = (plates: any[]) => plates.reduce((a: any, p: any) => ({ ...a, [p.level]: (a[p.level] ?? 0) + 1 }), {});

test('few jobs: one plate per job, heaviest first', () => {
  const p = loadPlates(jobs(1, 2, 3));
  assert.deepEqual([...p.map((x: any) => x.level)], ['heavy', 'mid', 'mid', 'light', 'light', 'light']);
  assert.ok(p.every((x: any) => x.count === 1));
});

test('212 jobs never exceed the cap and every job is accounted for', () => {
  for (const max of [MAX_PLATES.wide, MAX_PLATES.narrow]) {
    const p = loadPlates(jobs(3, 9, 200), max);
    assert.equal(p.length, max);
    assert.equal(p.reduce((a: number, x: any) => a + x.count, 0), 212);
    const t = tally(p);
    assert.ok(t.heavy >= 1 && t.mid >= 1, 'small groups keep a plate');
    assert.ok(t.light > t.mid && t.mid >= t.heavy, 'proportional to job counts');
  }
});

test('each plate points at the first job it stands for', () => {
  const p = loadPlates(jobs(0, 0, 50), 10);
  assert.equal(p[0].job.to, 'l0');
  assert.equal(p[1].job.to, 'l5');
  assert.ok(p.every((x: any) => x.count === 5));
});

test('no jobs → no plates', () => assert.equal(loadPlates([]).length, 0));
