import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCopy, displayName, inr, leaks, pct, splitAnswer, units, whole } from '../src/copy.ts';
import { errorResponse, fail } from '../src/errors.ts';
import { publicAnswer, publicHealth, publicRun } from '../src/present.ts';

test('money and units: ₹ with Indian grouping, whole units only', () => {
  assert.equal(inr(102499), '₹1,02,499');
  assert.equal(inr(1724.6), '₹1,725');
  assert.equal(whole(0.28), 0);
  assert.equal(units(14.94), '15 units');
  assert.equal(units(1), '1 unit');
  assert.equal(pct(13.6), '14%');
  assert.equal(displayName('Supplier C (Sports Mart)'), 'Supplier C, Sports Mart');
});

test('cleanCopy: drops forecast labels and long asides, rounds tiny decimals, keeps short asides as plain words', () => {
  const old = "Business brief for 4 Oct (TabPFN forecast)\n• Top seller this week: Watermelon Candy (14.94 sold).\n• Save money: X at ₹1,632 instead of ₹1,886 (Supplier C (Sports Mart)), saving ₹254 per unit (13.5%)\nDemand: search-interest proxy, not real sales";
  const c = cleanCopy(old);
  assert.equal(c, 'Business brief for 4 Oct\n• Top seller this week: Watermelon Candy, 15 sold.\n• Save money: X at ₹1,632 instead of ₹1,886, saving ₹254 per unit, 14%');
  assert.equal(leaks(c), false);
  assert.doesNotMatch(cleanCopy('~0.28 sold / 7d'), /0\.28/);
});

test('splitAnswer: short lead plus bullets', () => {
  assert.deepEqual(splitAnswer('You have 2 pending orders.\n• A: ₹100\n• B: ₹200'), { lead: 'You have 2 pending orders.', bullets: ['A: ₹100', 'B: ₹200'] });
  assert.equal(publicAnswer({}).answer, "I couldn't find an answer to that. Try asking another way.");
});

test('leaks: catches internals, passes normal shop copy', () => {
  for (const s of ['trace id f4c1', 'traceId', 'TabPFN unavailable', 'hybrid-fts+pgvector', 'keyword-router', 'mongodb+srv://u:p@h', 'accessDate', 'undefined', '[object Object]', 'at handler (/app/src/server.ts:12:5)']) assert.equal(leaks(s), true, s);
  assert.equal(leaks('Restock Whey Protein now: 9 left, delivery takes 4 days.'), false);
});

test('errorResponse: only AppError messages reach the owner; raw errors get a plain default', () => {
  const raw = errorResponse(new Error('MongoServerError: auth failed for mongodb+srv://admin:pw@cluster0'));
  assert.equal(raw.status, 500);
  assert.deepEqual(raw.body, { error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  const upstream = errorResponse(Object.assign(new Error('Gemma (gemma3:4b) unavailable at http://10.0.0.5:11434: ECONNREFUSED'), { status: 503 }));
  assert.equal(upstream.status, 503);
  assert.doesNotMatch(JSON.stringify(upstream.body), /gemma3|11434|ECONN/);
  const own = errorResponse(fail('order_not_pending', 'That order is already delivered or no longer exists.', 404, 'internal detail'));
  assert.deepEqual(own, { status: 404, body: { error: { code: 'order_not_pending', message: 'That order is already delivered or no longer exists.' } } });
  assert.equal(errorResponse({ type: 'entity.parse.failed', status: 400 }).body.error.code, 'bad_json');
  assert.equal(errorResponse({ status: 200 }).status, 500);
});

test('publicHealth and publicRun: plain words, no hosts, ids or runner names', () => {
  const h = publicHealth({ date: '2026-10-04', mongo: true, gemma: false, mastra: false, forecast: { method: 'fallback-moving-average', fallbackReason: 'spawn python ENOENT' }, tiger: false, serpapi: false, backboard: false, elevenlabs: false, temporal: false, sentry: false });
  const text = JSON.stringify(h);
  for (const v of Object.values<any>(h.integrations)) assert.equal(leaks(v.note), false, v.note);
  assert.doesNotMatch(text, /ENOENT|python|moving-average/);
  const r = publicRun('dailyBriefWorkflow', { mode: 'direct', runner: 'direct-fallback (Temporal unavailable)', traceId: 'abc', retries: ['x failed: boom'], result: { forecast: { method: 'tabpfn', highRisk: 2 }, dailyBrief: { text: 'Brief (TabPFN forecast)\n• Top seller: Bar (0.28 sold).' } } });
  assert.deepEqual(r, { name: 'dailyBriefWorkflow', label: 'Morning brief', done: true, steps: { forecast: { runsOutFirst: 2 }, dailyBrief: { text: 'Brief\n• Top seller: Bar, 0 sold.' } } });
});
