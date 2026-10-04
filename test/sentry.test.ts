// Offline Sentry check: real SDK (v11 streams spans), every outgoing envelope captured by a fake transport (nothing leaves the machine).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';

process.env.MONGODB_DB = 'nivara_test';
process.env.LOG_LEVEL = 'silent';
process.env.OLLAMA_API_KEY = 'sk-ollama-secret';
delete process.env.SENTRY_SEND_CONTENT;

const spans: any[] = [], errors: any[] = [], envelopes: any[] = [];
Sentry.init({
  dsn: 'https://public@o0.ingest.sentry.io/0', tracesSampleRate: 1,
  transport: () => ({ send: async (env: any) => { envelopes.push(env); return {}; }, flush: async () => true }),
  beforeSendSpan: s => { spans.push(s); return s; },
  beforeSend: e => { errors.push(e); return e; },
});

const { traced, gemma, annotate } = await import('../src/integrations.ts');
const { client } = await import('../src/db.ts');
after(async () => { await client.close(); await Sentry.close(); });

const realFetch = globalThis.fetch;

test('agent run → invoke_agent transaction with model span, usage, metadata; content and secrets absent', async () => {
  let auth = '';
  globalThis.fetch = (async (_u: any, init: any) => { auth = init.headers.authorization; return Response.json({ choices: [{ message: { content: 'Rahul Verma owes ₹500' } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }); }) as typeof fetch;
  try {
    await traced('assistant', 'Rahul Verma 9876543210 wants whey', async () => {
      await gemma([{ role: 'user', content: 'Rahul Verma 9876543210 wants whey' }]);
      annotate({ 'nivara.route': 'gemma-json-router', 'gen_ai.tool.name': 'get_inventory', 'nivara.answer_mode': 'template' });
      return { answer: 'ok' };
    });
  } finally { globalThis.fetch = realFetch; }
  await Sentry.flush(2000);
  assert.equal(auth, 'Bearer sk-ollama-secret'); // used on the wire…
  const root = spans.find(s => s.is_segment)!;
  assert.equal(root.name, 'invoke_agent assistant');
  assert.equal(root.attributes['sentry.op'], 'gen_ai.invoke_agent');
  assert.equal(root.attributes['nivara.answer_mode'], 'template');
  assert.equal(root.attributes['nivara.route'], 'gemma-json-router');
  assert.equal(root.attributes['gen_ai.tool.name'], 'get_inventory');
  assert.equal(root.attributes['gen_ai.request.model'], 'gemma3:4b');
  const chat = spans.find(s => s.attributes['sentry.op'] === 'gen_ai.chat')!;
  assert.equal(chat.parent_span_id, root.span_id);
  assert.equal(chat.attributes['gen_ai.usage.input_tokens'], 42);
  assert.equal(chat.attributes['gen_ai.usage.output_tokens'], 7);
  assert.match(chat.attributes['gen_ai.request.messages'], /^\[redacted \d+ chars\]$/);
  assert.match(chat.attributes['gen_ai.response.text'], /^\[redacted \d+ chars\]$/);
  assert.ok(envelopes.length > 0);
  const all = JSON.stringify(envelopes);
  for (const secret of ['Rahul', '9876543210', 'sk-ollama-secret', '₹500']) assert.ok(!all.includes(secret), `${secret} leaked to Sentry`); // …but never sent to Sentry
});

test('failed agent run is captured as a Sentry error', async () => {
  await assert.rejects(traced('assistant', 'x', async () => { throw new Error('tool exploded'); }), /tool exploded/);
  await Sentry.flush(2000);
  const e = errors.at(-1);
  assert.equal(e.exception.values[0].value, 'tool exploded');
  assert.equal(e.tags['nivara.kind'], 'assistant');
});
