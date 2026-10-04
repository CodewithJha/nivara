// public/api.js is a plain browser script; run it in a vm context with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/api.js', import.meta.url), 'utf8');

function load(handler: (url: string, init: any) => Promise<Response> | Response) {
  const calls: { url: string; init: any }[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); return handler(url, init); };
  const ctx = vm.createContext({ fetch, AbortController, Blob, setTimeout, clearTimeout });
  const { api, ApiError, API } = vm.runInContext(`${source}\n({ api, ApiError, API })`, ctx);
  API.retryDelayMs = 0;
  return { api, ApiError, API, calls };
}
const kindOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.kind);

test('api: JSON body in, JSON out', async () => {
  const { api, calls } = load(() => Response.json({ ok: 1 }));
  assert.deepEqual({ ...(await api('/x', { method: 'POST', body: { a: 1 } })) }, { ok: 1 });
  assert.equal(calls[0].url, '/api/x');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, '{"a":1}');
});

test('api: GET retries once on 5xx, then succeeds', async () => {
  let n = 0;
  const { api, calls } = load(() => (++n === 1 ? Response.json({ error: 'boom' }, { status: 502 }) : Response.json({ ok: true })));
  assert.equal((await api('/x')).ok, true);
  assert.equal(calls.length, 2);
});

test('api: GET retries once on a network error, then throws a typed error', async () => {
  const { api, calls } = load(() => { throw new TypeError('Load failed'); });
  const err = await api('/x').catch((e: any) => e);
  assert.equal(err.name, 'ApiError');
  assert.equal(err.kind, 'network');
  assert.equal(err.detail, 'Load failed');
  assert.equal(calls.length, 2);
});

test('api: writes are not retried unless marked safe', async () => {
  const failing = () => Response.json({ error: 'down' }, { status: 503 });
  const write = load(failing);
  assert.equal(await kindOf(write.api('/orders', { method: 'POST', body: {} })), 'server');
  assert.equal(write.calls.length, 1);
  const safe = load(failing);
  assert.equal(await kindOf(safe.api('/assistant', { method: 'POST', body: {}, retry: true })), 'server');
  assert.equal(safe.calls.length, 2);
});

test('api: 4xx is a request error with status, never retried', async () => {
  const { api, calls } = load(() => Response.json({ error: 'Unknown SKU(s): X' }, { status: 400 }));
  const err = await api('/x').catch((e: any) => e);
  assert.equal(err.kind, 'request');
  assert.equal(err.status, 400);
  assert.equal(err.retryable, false);
  assert.equal(calls.length, 1);
});

test('api: aborts after the timeout and does not retry it', async () => {
  const { api, API, calls } = load((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  API.timeoutMs = 20;
  assert.equal(await kindOf(api('/slow')), 'timeout');
  assert.equal(calls.length, 1);
});

test('api: non-JSON success body is a server error; blobs pass through with their type', async () => {
  assert.equal(await kindOf(load(() => new Response('<html>')).api('/x', { retry: false })), 'server');
  const { api, calls } = load(() => new Response('mp3'));
  const audio = new Blob(['x'], { type: 'audio/webm;codecs=opus' });
  assert.equal(await (await api('/voice/stt', { method: 'POST', body: audio, as: 'blob' })).text(), 'mp3');
  assert.equal(calls[0].init.headers['content-type'], 'audio/webm');
  assert.equal(calls[0].init.body, audio);
});
