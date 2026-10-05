// What the browser receives: friendly error envelope, and no secrets or internals in health and assistant responses.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.MONGODB_DB = 'nivara_test_public'; // one DB per file: node --test runs files in parallel processes
process.env.LOG_LEVEL = 'silent';
process.env.FORECAST_MODE = 'fallback';
// fake secrets and hosts that must never appear in a response
process.env.SERPAPI_API_KEY = 'serp-SECRET-123';
process.env.BACKBOARD_API_KEY = 'bb-SECRET-456';
process.env.OLLAMA_BASE_URL = 'http://ollama.secret-host.internal:11434';
process.env.OLLAMA_API_KEY = 'ollama-SECRET-789';
delete process.env.LLM_PROVIDER; delete process.env.TIGER_DATABASE_URL; delete process.env.TEMPORAL_ADDRESS; delete process.env.ELEVENLABS_API_KEY; delete process.env.SENTRY_DSN;

const { client, col, today } = await import('../src/db.ts');
const { app } = await import('../src/server.ts');
const { INTERNAL } = await import('../src/copy.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';

const realFetch = globalThis.fetch;
let base = '', server: any;
const LEAK = /SECRET|secret-host|mongodb(\+srv)?:\/\/|https?:\/\/|11434|api[_ ]?key|traceId|"route"|"tool"|"model"|"notes"|"data"|keyword-router|gemma-json|mastra-tools|fallback|proxy|TabPFN unavailable|hybrid-fts|pgvector|stack|accessDate|fetchedAt|undefined|\[object Object\]/i;

before(async () => {
  // every partner is down: model, SerpApi, Backboard. Responses must still be clean.
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    if (base && url.startsWith(base)) return realFetch(u, init);
    return new Response('upstream exploded: token=SECRET at /internal/path.js:12:3', { status: 503 });
  }) as typeof fetch;
  if (mongoOk) {
    await client.db(process.env.MONGODB_DB).dropDatabase();
    await col.products.insertMany([
      { _id: 'R01', name: 'Whey Protein', aliases: ['whey'], category: 'powder', price: 2499, cost: 1780, stock: 10, supplierId: 'S1', leadTimeDays: 6, origin: { license: 'ODbL', url: 'https://world.openfoodfacts.org/x' } } as any,
      { _id: 'R02', name: 'Protein Bar', aliases: ['bar'], category: 'bars', price: 95, cost: 60, stock: 3, supplierId: 'S1', leadTimeDays: 4 },
    ]);
    await col.suppliers.insertOne({ _id: 'S1', name: 'Supplier C (Sports Mart)', quotes: [] } as any);
    await col.orders.insertOne({ _id: 'O1', customerId: 'C1', customerName: 'Rahul Verma', items: [{ sku: 'R02', name: 'Protein Bar', quantity: 2, price: 95 }], total: 190, status: 'pending', deliveryDate: today(), createdAt: new Date(), source: 'sample-csv' } as any);
    await col.sales.insertMany(Array.from({ length: 14 }, (_, i) => ({ sku: 'R02', date: new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10), qty: 0.28 })) as any);
  }
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
after(async () => { globalThis.fetch = realFetch; server.close(); if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

const get = (p: string) => realFetch(base + p);
const post = (p: string, body: string | object, type = 'application/json') => realFetch(base + p, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const envelope = async (r: Response, status: number) => {
  assert.equal(r.status, status);
  const j = await r.json();
  assert.deepEqual(Object.keys(j), ['error']);
  assert.deepEqual(Object.keys(j.error).sort(), ['code', 'message']);
  assert.match(j.error.code, /^[a-z_]+$/);
  assert.doesNotMatch(j.error.message, LEAK);
  assert.doesNotMatch(j.error.message, /zod|✖|expected|sku|HTTP \d/i);
  return j.error;
};

test('static files: index.html revalidates, versioned assets and fonts cache for a year', async () => {
  const r = await get('/');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const html = await r.text();
  const assets = [...html.matchAll(/(?:src|href)="([\w-]+\.(?:js|css)\?v=[0-9a-f]{10})"/g)].map(m => m[1]);
  assert.deepEqual(assets.map(a => a.split('?')[0]).sort(), ['api.js', 'app.js', 'lazy.js', 'nav.js', 'plates.js', 'styles.css', 'voice.js']);
  for (const a of assets) assert.equal((await get('/' + a)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/app.js')).headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/fonts/anybody-latin.woff2')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/index.html')).headers.get('cache-control'), 'no-cache');
});

test('error envelope: unknown route, unreadable JSON, missing input', async () => {
  assert.equal((await envelope(await get('/api/nope'), 404)).code, 'not_found');
  assert.equal((await envelope(await post('/api/assistant', '{bad'), 400)).code, 'bad_json');
  const e = await envelope(await post('/api/assistant', { message: '' }), 400);
  assert.equal(e.message, 'Type a question first, up to 500 characters.');
  await envelope(await get('/api/suppliers/search?q=x'), 400);
});

test('error envelope: write paths explain the problem in plain words', { skip }, async () => {
  const e = await envelope(await post('/api/orders', { customerName: 'X', items: [{ sku: 'ZZZ', quantity: 1 }] }), 400);
  assert.equal(e.code, 'unknown_product');
  assert.equal((await envelope(await post('/api/orders/NOPE/deliver', {}), 404)).code, 'order_not_pending');
  assert.equal((await envelope(await post('/api/memory', { text: 'x' }), 400)).code, 'invalid_input');
});

test('voice without a key: quiet envelope plus a browser fallback hint', async () => {
  const r = await post('/api/voice/stt', 'abc', 'audio/webm');
  assert.equal(r.status, 501);
  const j = await r.json();
  assert.equal(j.fallback, 'browser-web-speech');
  assert.equal(j.error.code, 'voice_unavailable');
  assert.doesNotMatch(j.error.message, /ELEVENLABS|key/i);
});

test('health: partner names, live/standby and plain notes only; no keys, hosts or URIs', { skip }, async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const text = await r.text(), j = JSON.parse(text);
  assert.doesNotMatch(text, LEAK);
  for (const [k, v] of Object.entries<any>(j.integrations)) {
    assert.deepEqual(Object.keys(v).sort(), ['name', 'note', 'status'], k);
    assert.match(v.status, /^(live|standby)$/, k);
    assert.equal(INTERNAL.test(v.note), false, `${k}: ${v.note}`);
  }
  assert.equal(j.integrations.gemma.status, 'standby');
});

test('assistant: answer, lead and bullets only; whole units, no internals even with every partner down', { skip }, async () => {
  for (const message of ['which orders are pending', "Give me today's business brief", 'What sold the most?', 'Whey under 3000', 'Find cheaper suppliers for whey']) {
    const r = await post('/api/assistant', { message });
    assert.equal(r.status, 200, message);
    const text = await r.text(), j = JSON.parse(text);
    assert.deepEqual(Object.keys(j), ['answer', 'lead', 'bullets'], message);
    assert.doesNotMatch(text, LEAK, message);
    assert.doesNotMatch(j.answer, /\d+\.\d+ (sold|units?|days?)|[()]/, message);
    assert.ok(j.lead.length > 0 && j.lead.split(/[.!?](\s|$)/).filter((s: string) => s.trim()).length <= 3, `${message}: ${j.lead}`);
  }
  const orders = await (await post('/api/assistant', { message: 'which orders are pending' })).json();
  assert.equal(orders.lead, 'You have 1 pending order.');
  assert.deepEqual(orders.bullets, ['Rahul Verma: 2× Protein Bar · ₹190 · due today']);
});

test('seller pages: no provenance, licence, method or model fields', { skip }, async () => {
  for (const p of ['/api/dashboard', '/api/inventory', '/api/forecast', '/api/orders', '/api/suppliers', '/api/memory', '/api/workflows', '/api/traces']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const text = await r.text();
    assert.doesNotMatch(text, LEAK, p);
    assert.doesNotMatch(text, /"(method|model|origin|license|fallbackReason|precomputed|demandNote|spans|attrs|uiUrl|runner|mode)"/, p);
    assert.doesNotMatch(text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, ''), /\d+\.\d{2,}/, `${p}: tiny decimals`);
  }
  const s = await (await get('/api/suppliers')).json();
  assert.equal(s.suppliers[0].name, 'Supplier C, Sports Mart');
});
