import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.MONGODB_DB = 'nivara_test_voice'; // one DB per file: node --test runs files in parallel processes
process.env.LOG_LEVEL = 'silent';
delete process.env.ELEVENLABS_API_KEY;

const { client, col } = await import('../src/db.ts');
const { app } = await import('../src/server.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const servers: any[] = [];
let base = '';
const realFetch = globalThis.fetch;

before(async () => {
  if (mongoOk) {
    await col.products.deleteMany({});
    await col.products.insertOne({ _id: 'R01', name: 'Whey Protein', aliases: ['whey'], category: 'powder', price: 2499, cost: 1780, stock: 10, supplierId: 'S3', leadTimeDays: 6 });
    await col.customers.deleteMany({});
    await col.customers.insertOne({ _id: 'C01', name: 'Rahul Verma', channel: 'whatsapp' });
  }
  await new Promise<void>(r => { const s = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; servers.push(s); r(); }); });
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.ELEVENLABS_API_KEY; });
after(async () => { servers.forEach(s => s.close()); if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

test('voice/order without key → 501', { skip: !mongoOk && 'MongoDB not reachable' }, async () => {
  const r = await fetch(`${base}/api/voice/order`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('x') });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).fallback, 'browser-web-speech');
});

test('voice/order STT → extract draft', { skip: !mongoOk && 'MongoDB not reachable' }, async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key';
  await col.products.deleteMany({});
  await col.products.insertOne({ _id: 'R01', name: 'Whey Protein', aliases: ['whey'], category: 'powder', price: 2499, cost: 1780, stock: 10, supplierId: 'S3', leadTimeDays: 6 });
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    if (url.includes('/v1/user')) return Response.json({ user_id: 'u' });
    if (url.includes('speech-to-text')) return Response.json({ text: 'Rahul Verma: 2 whey protein tomorrow' });
    if (url.includes('11434') || url.includes('generativelanguage')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ customer: 'Rahul Verma', items: [{ product: 'Whey Protein', quantity: 2 }], delivery_text: 'tomorrow' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const r = await fetch(`${base}/api/voice/order`, { method: 'POST', headers: { 'content-type': 'audio/mp4' }, body: Buffer.from('fake-audio') });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.match(j.text, /whey protein/i);
  assert.equal(j.draft.items[0].product?.name, 'Whey Protein');
  assert.equal(j.draft.items[0].quantity, 2);
  assert.match(j.note, /Draft only/);
});
