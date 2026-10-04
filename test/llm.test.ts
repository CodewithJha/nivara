// Provider selection and Gemini failure paths. fetch is mocked; nothing leaves the machine.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'silent';
delete process.env.LLM_PROVIDER;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;

const { OLLAMA, gemma, gemmaCapabilities, llmDownNote, llmModel, llmProvider } = await import('../src/integrations.ts');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LLM_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

function install(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    calls.push({ url: String(u), init });
    return handler(String(u), init ?? {});
  }) as typeof fetch;
  return calls;
}

test('default provider is ollama and posts to the OpenAI-compatible endpoint', async () => {
  const calls = install(() => Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  assert.equal(llmProvider(), 'ollama');
  assert.equal(llmModel(), process.env.GEMMA_MODEL || 'gemma3:4b');
  assert.equal(await gemma([{ role: 'user', content: 'hi' }]), 'ok');
  assert.equal(calls[0].url, `${OLLAMA}/v1/chat/completions`);
  assert.equal(JSON.parse(String(calls[0].init.body)).model, llmModel());
  assert.match(llmDownNote(), new RegExp(`unreachable at ${OLLAMA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(llmDownNote(), /keyword router \+ templated answer/);
});

test('gemini selects the free-tier Gemma model and the generateContent REST call', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';
  const calls = install(() => Response.json({
    candidates: [{ content: { parts: [{ text: 'hello' }, { text: ' there' }] } }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
  }));
  assert.equal(llmProvider(), 'gemini');
  assert.equal(llmModel(), 'gemma-4-31b-it');
  assert.equal(await gemma([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'prev' },
  ], { json: true, timeoutMs: 1000 }), 'hello there');
  const [call] = calls;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent');
  assert.equal((call.init.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(body.contents.map((c: any) => c.role), ['user', 'model']);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  process.env.GEMINI_MODEL = 'gemma-4-26b-a4b-it';
  assert.equal(llmModel(), 'gemma-4-26b-a4b-it');
});

test('gemini with no key, an HTTP error, or a timeout does not call a live model and is labelled as the template fallback', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  let hits = 0;
  globalThis.fetch = (async () => { hits++; return Response.json({}); }) as typeof fetch;
  assert.equal(await gemmaCapabilities(), null);
  await assert.rejects(gemma([{ role: 'user', content: 'hi' }]), /GEMINI_API_KEY missing/);
  assert.equal(hits, 0);
  const note = llmDownNote();
  assert.match(note, /gemma-4-31b-it/);
  assert.match(note, /Gemini API/);
  assert.match(note, /keyword router \+ templated answer/);
  assert.doesNotMatch(note, /11434/);

  process.env.GEMINI_API_KEY = 'test-key';
  install(() => new Response('nope', { status: 429 }));
  await assert.rejects(gemma([{ role: 'user', content: 'hi' }], { timeoutMs: 1000 }), /HTTP 429/);
  assert.equal(await gemmaCapabilities(), null);

  install((_url, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason))));
  await assert.rejects(gemma([{ role: 'user', content: 'hi' }], { timeoutMs: 30 }), /unavailable \(Gemini API\)/);
  assert.equal(await gemmaCapabilities(), null);
});
