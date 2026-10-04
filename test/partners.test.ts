// Partner code paths with mocked fetch (no real keys needed) against a throwaway Mongo DB.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.MONGODB_DB = 'nivara_test';
process.env.LOG_LEVEL = 'silent';
process.env.SUPPLIER_FAIL_FIRST_N = '0';
const KEYS = ['SERPAPI_API_KEY', 'BACKBOARD_API_KEY', 'BACKBOARD_ASSISTANT_ID', 'ELEVENLABS_API_KEY'];
KEYS.forEach(k => delete process.env[k]);

const { client, col, today } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const { normalizeOffers, elevenStatus } = await import('../src/integrations.ts');
const { app } = await import('../src/server.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';

const realFetch = globalThis.fetch;
let base = '';
function mockFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    if (base && url.startsWith(base)) return realFetch(u, init);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

async function reset() {
  for (const c of ['products', 'suppliers', 'preferences', 'forecasts', 'supplierPrices', 'meta', 'orders'] as const) await col[c].deleteMany({});
  await col.products.insertOne({ _id: 'P04', name: 'Whey Protein 1kg Chocolate', aliases: ['whey'], category: 'powder', price: 2499, cost: 1780, stock: 2, supplierId: 'S3', leadTimeDays: 6 });
  await col.suppliers.insertMany([
    { _id: 'S1', name: 'FitFuel Distributors', quotes: [{ sku: 'P04', unitCost: 1600 }] },
    { _id: 'S2', name: 'GymGear Wholesale', quotes: [{ sku: 'P04', unitCost: 1750 }] },
    { _id: 'S3', name: 'NutriHub India', quotes: [] },
    { _id: 'S4', name: 'Supplier C (Sports Mart)', quotes: [{ sku: 'P04', unitCost: 1500 }] },
  ]);
  await col.preferences.insertOne({ text: "I don't buy from Supplier C", kind: 'block_supplier', supplier: 'Supplier C (Sports Mart)', createdAt: new Date(), mirror: 'local-only' });
  await col.forecasts.insertOne({ date: today(), method: 'tabpfn', items: [{ sku: 'P04', name: 'Whey Protein 1kg Chocolate', stock: 2, reserved: 0, leadTimeDays: 6, demand7: 10 }], createdAt: new Date() });
}

before(async () => { if (mongoOk) await reset(); await new Promise<void>(r => { const s = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; servers.push(s); r(); }); }); });
const servers: any[] = [];
afterEach(async () => { globalThis.fetch = realFetch; KEYS.forEach(k => delete process.env[k]); if (mongoOk) await reset(); });
after(async () => { servers.forEach(s => s.close()); if (mongoOk) await client.db().dropDatabase(); await client.close(); });

// ---------- SerpApi via the supplierRefresh activity ----------

const serpResults = [
  { title: 'Whey Protein 1kg Chocolate', source: 'Amazon.in', extracted_price: 1650, link: 'https://www.amazon.in/dp/123' },
  { title: 'Whey 1kg', source: 'Supplier C (Sports Mart)', extracted_price: 1400, link: 'https://sportsmart.example/whey' },
  { title: '', source: 'Junk', extracted_price: -1, link: 'javascript:alert(1)' },
  { title: 'No link', source: 'X', extracted_price: 100 },
];

test('SerpApi refresh stores normalized, validated, blocked-filtered offers', { skip }, async () => {
  process.env.SERPAPI_API_KEY = 'serp-test-key';
  const calls = mockFetch(() => Response.json({ shopping_results: serpResults }));
  const r = await ops.supplierPriceRefresh(1);
  assert.equal(r.source, 'serpapi');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /engine=google_shopping/);
  const doc = await col.supplierPrices.findOne({ _id: 'P04' });
  assert.equal(doc.offers.length, 1);
  assert.deepEqual({ price: doc.cheapest.price, source: doc.cheapest.source, domain: doc.sourceDomain, link: doc.link }, { price: 1650, source: 'Amazon.in', domain: 'amazon.in', link: 'https://www.amazon.in/dp/123' });
  assert.equal(doc.hiddenBlocked, 1);
  assert.equal(doc.rejected, 2);
  assert.ok(doc.checkedAt instanceof Date);
  assert.doesNotMatch(JSON.stringify(doc), /serp-test-key/);
  assert.equal((await ops.livePrices()).length, 1);
});

test('SerpApi HTTP error: activity fails (Temporal retries), nothing stored, stored quotes remain', { skip }, async () => {
  process.env.SERPAPI_API_KEY = 'serp-test-key';
  mockFetch(() => new Response('quota exceeded', { status: 429 }));
  await assert.rejects(ops.supplierPriceRefresh(1), /SerpApi HTTP 429/);
  assert.equal(await col.supplierPrices.countDocuments(), 0);
  const opp = (await ops.supplierOpportunities()).find(o => o.sku === 'P04');
  assert.equal(opp?.best.supplier, 'FitFuel Distributors');
});

test('malformed SerpApi results are rejected', () => {
  assert.deepEqual(normalizeOffers(undefined), { offers: [], rejected: 0 });
  const { offers, rejected } = normalizeOffers(serpResults);
  assert.equal(offers.length, 2);
  assert.equal(rejected, 2);
  assert.ok(offers.every(o => o.price > 0 && /^https:/.test(o.link) && o.sourceDomain));
});

test('no SerpApi key: no network call, stored quote used, blocked supplier skipped', { skip }, async () => {
  const calls = mockFetch(() => { throw new Error('should not be called'); });
  const r = await ops.supplierPriceRefresh(1);
  assert.equal(r.source, 'stored');
  assert.equal(calls.length, 0);
  const opp = (await ops.supplierOpportunities()).find(o => o.sku === 'P04')!;
  assert.deepEqual({ supplier: opp.best.supplier, saving: opp.savingPerUnit, pct: opp.savingPercent, significant: opp.significant, skipped: opp.skippedBlocked }, { supplier: 'FitFuel Distributors', saving: 180, pct: 10.1, significant: true, skipped: ['Supplier C (Sports Mart)'] });
});

test('SUPPLIER_FAIL_FIRST_N still simulates the outage for the retry demo', async () => {
  process.env.SUPPLIER_FAIL_FIRST_N = '2';
  await assert.rejects(ops.supplierPriceRefresh(2), /Simulated supplier API outage \(attempt 2\/2/);
  process.env.SUPPLIER_FAIL_FIRST_N = '0';
});

// ---------- Backboard ----------

function backboard(memories: string[], fail = false) {
  return mockFetch((url, init) => {
    assert.equal(init.headers['X-API-Key'], 'bb-test-key');
    if (fail) return new Response('down', { status: 503 });
    if (url.endsWith('/api/assistants') && init.method === 'POST') return Response.json({ assistant_id: 'asst-1' });
    if (url.endsWith('/assistants/asst-1/memories') && init.method === 'POST') return Response.json({ id: 'mem-1' }, { status: 201 });
    if (url.endsWith('/assistants/asst-1/memories/search')) return Response.json({ memories: memories.map((content, i) => ({ id: `m${i}`, content, score: 0.9 })), total_count: memories.length });
    if (url.endsWith('/assistants/asst-1/memories')) return Response.json({ memories: memories.map((content, i) => ({ id: `m${i}`, content })), total_count: memories.length });
    return new Response('unexpected ' + url, { status: 404 });
  });
}

test('Backboard save: Mongo rule + Backboard memory', { skip }, async () => {
  process.env.BACKBOARD_API_KEY = 'bb-test-key';
  const calls = backboard([]);
  const r = await ops.saveMemory("Remember that I don't buy from FitFuel");
  assert.deepEqual({ kind: r.saved.kind, supplier: r.saved.supplier, mirror: r.saved.mirror, id: r.saved.backboardId }, { kind: 'block_supplier', supplier: 'FitFuel Distributors', mirror: 'backboard', id: 'mem-1' });
  assert.equal(JSON.parse(calls.at(-1)!.init.body).content, "Remember that I don't buy from FitFuel");
  assert.equal(await col.preferences.countDocuments({ supplier: 'FitFuel Distributors' }), 1);
});

test('Backboard retrieve: memories listed alongside Mongo preferences', { skip }, async () => {
  process.env.BACKBOARD_API_KEY = 'bb-test-key';
  backboard(['Owner prefers suppliers within 5 days delivery']);
  const m = await ops.getMemory();
  assert.equal(m.backboard.live, true);
  assert.deepEqual(m.backboard.memories, ['Owner prefers suppliers within 5 days delivery']);
  assert.equal(m.preferences.length, 1);
});

test('Backboard memory changes a later supplier decision', { skip }, async () => {
  process.env.BACKBOARD_API_KEY = 'bb-test-key';
  backboard(['Never buy from FitFuel Distributors, they shipped expired stock']);
  const r = await ops.searchSupplierPrices('whey');
  assert.equal(r.memory.source, 'mongo + backboard');
  assert.equal(r.dbOpportunity?.best.supplier, 'GymGear Wholesale');
  assert.ok(r.dbOpportunity?.skippedBlocked.includes('FitFuel Distributors'));
});

test('Backboard unavailable: Mongo-only, labelled; save still persists locally', { skip }, async () => {
  process.env.BACKBOARD_API_KEY = 'bb-test-key';
  backboard([], true);
  const r = await ops.searchSupplierPrices('whey');
  assert.match(r.memory.source, /^mongo only \(Backboard unavailable: Backboard HTTP 503/);
  assert.equal(r.dbOpportunity?.best.supplier, 'FitFuel Distributors');
  const s = await ops.saveMemory('Avoid GymGear Wholesale');
  assert.equal(s.saved.mirror, 'local-only');
  assert.match(s.backboardError!, /503/);
  assert.equal(await col.preferences.countDocuments({ supplier: 'GymGear Wholesale' }), 1);
});

// ---------- ElevenLabs ----------

const post = (path: string, body: any, type: string) => realFetch(base + path, { method: 'POST', headers: { 'content-type': type }, body });

test('ElevenLabs absent: 501 with browser fallback hint', async () => {
  const stt = await post('/api/voice/stt', new Uint8Array([1, 2, 3]), 'audio/webm');
  assert.equal(stt.status, 501);
  assert.equal((await stt.json()).fallback, 'browser-web-speech');
  const tts = await post('/api/voice/tts', JSON.stringify({ text: 'hi' }), 'application/json');
  assert.equal(tts.status, 501);
  assert.equal((await elevenStatus()).ok, false);
});

test('ElevenLabs present: Scribe called with the recording\'s real file type (Safari mp4)', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-test-key';
  const calls = mockFetch(() => Response.json({ text: 'what should I restock' }));
  const r = await post('/api/voice/stt', new Uint8Array([1, 2, 3]), 'audio/mp4');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'what should I restock');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(calls[0].init.headers['xi-api-key'], 'el-test-key');
  assert.equal((calls[0].init.body as FormData).get('file') instanceof File && ((calls[0].init.body as FormData).get('file') as File).name, 'audio.mp4');
});

test('ElevenLabs provider failure surfaces 502 so the client falls back', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-test-key';
  mockFetch(() => new Response('quota', { status: 401 }));
  const stt = await post('/api/voice/stt', new Uint8Array([1]), 'audio/webm');
  assert.equal(stt.status, 502);
  assert.equal((await stt.json()).fallback, 'browser-web-speech');
  const tts = await post('/api/voice/tts', JSON.stringify({ text: 'hi' }), 'application/json');
  assert.equal(tts.status, 502);
});

test('ElevenLabs status is live only after the key is verified', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-bad-key';
  mockFetch(() => new Response('', { status: 401 }));
  assert.deepEqual(await elevenStatus(), { ok: false, detail: 'key rejected (HTTP 401) — browser speech' });
  process.env.ELEVENLABS_API_KEY = 'el-good-key';
  const calls = mockFetch(() => Response.json({ subscription: {} }));
  assert.equal((await elevenStatus()).ok, true);
  await elevenStatus();
  assert.equal(calls.length, 1, 'cached');
});
