// Every external dependency lives here, each with an explicit "is it live?" check and a fallback.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';
import pino from 'pino';
import { z } from 'zod';
import { col } from './db.ts';

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const env = process.env;

export const OLLAMA = (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
export const MODEL = env.GEMMA_MODEL ?? 'gemma3:4b';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/** `ollama` (default) or `gemini`. Anything else stays on Ollama. Read at call time so env wins over import order. */
export const llmProvider = (): 'ollama' | 'gemini' => env.LLM_PROVIDER?.trim().toLowerCase() === 'gemini' ? 'gemini' : 'ollama';
export const llmModel = () => llmProvider() === 'gemini' ? (env.GEMINI_MODEL || 'gemma-4-31b-it') : (env.GEMMA_MODEL || 'gemma3:4b');
/** Assistant note when the model can't be used. Same fallback the keyword router already shows. */
export const llmDownNote = () => llmProvider() === 'gemini'
  ? `Gemma (${llmModel()}) unavailable (Gemini API); keyword router + templated answer.`
  : `Gemma (${llmModel()}) unreachable at ${OLLAMA}; keyword router + templated answer.`;

// ---------- tracing: Sentry gen_ai spans + local span store (works without a DSN) ----------
// Sentry.init lives in instrument.ts (preloaded with --import so express/http get auto-instrumented).

type LocalSpan = { name: string; op: string; start: number; ms?: number; attrs: Record<string, any>; error?: string };
const run = new AsyncLocalStorage<{ id: string; spans: LocalSpan[] }>();
const clip = (v: any, n = 1500) => { if (typeof v === 'number' || typeof v === 'boolean') return v; const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
// Prompts, answers and tool I/O contain customer names and business data: local Mongo traces keep them, Sentry gets lengths only.
const CONTENT = new Set(['gen_ai.request.messages', 'gen_ai.response.text', 'gen_ai.tool.input', 'gen_ai.tool.output']);
const forSentry = (k: string, v: any) => CONTENT.has(k) && env.SENTRY_SEND_CONTENT !== '1' ? `[redacted ${clip(v)?.length ?? 0} chars]` : clip(v);

/** One span, mirrored to Sentry (if configured) and the local trace of the current run. */
export async function span<T>(op: string, name: string, attrs: Record<string, any>, fn: (set: (k: string, v: any) => void) => Promise<T>): Promise<T> {
  const local: LocalSpan = { name, op, start: Date.now(), attrs: { ...attrs } };
  run.getStore()?.spans.push(local);
  return Sentry.startSpan({ op, name, attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, forSentry(k, v)])) }, async s => {
    const set = (k: string, v: any) => { local.attrs[k] = clip(v); s?.setAttribute(k, forSentry(k, v)); };
    try { return await fn(set); }
    catch (e: any) { local.error = e.message; s?.setStatus({ code: 2, message: e.message }); throw e; }
    finally { local.ms = Date.now() - local.start; }
  });
}

/** A traced agent/workflow run; persisted to Mongo so the Activity page can show it. */
export async function traced<T extends object>(kind: string, input: any, fn: () => Promise<T>): Promise<T & { traceId: string }> {
  const ctx = { id: randomUUID(), spans: [] as LocalSpan[] };
  const t0 = Date.now();
  let out: any, error: string | undefined;
  try {
    out = await run.run(ctx, () => span('gen_ai.invoke_agent', `invoke_agent ${kind}`, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': `nivara.${kind}`, 'gen_ai.request.model': llmModel() }, fn));
    return { ...out, traceId: ctx.id };
  } catch (e: any) { error = e.message; Sentry.captureException(e, { tags: { 'nivara.kind': kind } }); throw e; }
  finally {
    col.traces.insertOne({ _id: ctx.id, kind, input: clip(input, 500), output: clip(out?.answer ?? out, 2000), error, ms: Date.now() - t0, spans: ctx.spans, at: new Date(), sentry: !!env.SENTRY_DSN })
      .catch(e => log.warn({ err: e.message }, 'trace persist failed'));
  }
}

/** Add metadata (route, tool, answer mode…) to the current agent span, locally and in Sentry. */
export function annotate(attrs: Record<string, string | number | boolean>) {
  Object.assign(run.getStore()?.spans[0]?.attrs ?? {}, attrs);
  Sentry.getActiveSpan()?.setAttributes(attrs);
}

// ---------- Gemma: Ollama (default) or Gemini API (Google AI Studio). Same return: the assistant text. ----------

type ChatMsg = { role: string; content: string };
type ChatOpts = { json?: boolean; timeoutMs?: number };

async function ollamaChat(messages: ChatMsg[], opts: ChatOpts, model: string, set: (k: string, v: any) => void): Promise<string> {
  const unavailable = (why: string) => Object.assign(new Error(`Gemma (${model}) unavailable at ${OLLAMA}: ${why}`), { status: 503 });
  const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.OLLAMA_API_KEY && { authorization: `Bearer ${env.OLLAMA_API_KEY}` }) },
    body: JSON.stringify({ model, messages, temperature: 0.2, ...(opts.json && { response_format: { type: 'json_object' } }) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  }).catch(e => { throw unavailable(e.message); });
  if (!r.ok) throw unavailable(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  set('gen_ai.response.text', text);
  set('gen_ai.usage.input_tokens', j.usage?.prompt_tokens);
  set('gen_ai.usage.output_tokens', j.usage?.completion_tokens);
  return text;
}

async function geminiChat(messages: ChatMsg[], opts: ChatOpts, model: string, set: (k: string, v: any) => void): Promise<string> {
  const unavailable = (why: string) => Object.assign(new Error(`Gemma (${model}) unavailable (Gemini API): ${why}`), { status: 503 });
  if (!env.GEMINI_API_KEY) throw unavailable('GEMINI_API_KEY missing');
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const r = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      ...(system && { systemInstruction: { parts: [{ text: system }] } }),
      contents,
      generationConfig: { temperature: 0.2, ...(opts.json && { responseMimeType: 'application/json' }) },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  }).catch(e => { throw unavailable(e.message); });
  if (!r.ok) throw unavailable(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join(''); // skip thought summaries
  set('gen_ai.response.text', text);
  set('gen_ai.usage.input_tokens', j.usageMetadata?.promptTokenCount);
  set('gen_ai.usage.output_tokens', j.usageMetadata?.candidatesTokenCount);
  return text;
}

export async function gemma(messages: ChatMsg[], opts: ChatOpts = {}): Promise<string> {
  const provider = llmProvider();
  const model = llmModel();
  return span('gen_ai.chat', `chat ${model}`, { 'gen_ai.operation.name': 'chat', 'gen_ai.system': provider, 'gen_ai.request.model': model, 'gen_ai.request.messages': clip(messages) }, set =>
    provider === 'gemini' ? geminiChat(messages, opts, model, set) : ollamaChat(messages, opts, model, set));
}

/** Parse model JSON leniently (strip ```fences```), then the caller validates with zod. */
export const parseJson = (s: string) => JSON.parse(s.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, ''));

/** Model capabilities, e.g. ['completion','tools']; null if the selected provider is unusable. Gemini has no tools probe: a live key means completion. */
export async function gemmaCapabilities(): Promise<string[] | null> {
  if (llmProvider() === 'gemini') {
    if (!env.GEMINI_API_KEY) return null;
    try {
      const r = await fetch(`${GEMINI_API}/models/${encodeURIComponent(llmModel())}`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY }, signal: AbortSignal.timeout(3000) });
      return r.ok ? ['completion'] : null;
    } catch { return null; }
  }
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: llmModel() }), signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as any).capabilities ?? ['completion'] : null;
  } catch { return null; }
}

// ---------- TabPFN (python subprocess) ----------

const PY = env.TABPFN_PYTHON ?? fileURLToPath(new URL('../forecast/.venv/bin/python', import.meta.url));
const PY_SCRIPT = fileURLToPath(new URL('../forecast/forecast.py', import.meta.url));

/** series: { sku: daily qty[] (oldest→newest) } → { model, pred: { sku: next-7-day total } }. Throws on any failure. */
export function tabpfnForecast(series: Record<string, number[]>, timeoutMs = Number(env.TABPFN_TIMEOUT_MS ?? 180_000)): Promise<{ model: string; pred: Record<string, number> }> {
  return span('forecast.tabpfn', 'tabpfn regressor', { skus: Object.keys(series).length }, () => new Promise((resolve, reject) => {
    if (env.FORECAST_MODE === 'fallback') return reject(new Error('FORECAST_MODE=fallback'));
    if (!existsSync(PY)) return reject(new Error(`TabPFN python not found at ${PY}`));
    const p = spawn(PY, [PY_SCRIPT], { timeout: timeoutMs });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`tabpfn exit ${code}: ${err.trim().split('\n').pop()}`));
      try {
        const r = JSON.parse(out);
        if (typeof r?.pred !== 'object' || !Object.keys(series).every(k => typeof r.pred[k] === 'number' && Number.isFinite(r.pred[k]) && r.pred[k] >= 0)) throw new Error('bad output');
        resolve({ model: String(r.model), pred: r.pred });
      } catch (e: any) { reject(new Error('tabpfn invalid output: ' + e.message)); }
    });
    p.stdin.end(JSON.stringify(series));
  }));
}

// ---------- SerpApi Google Shopping ----------

const OfferSchema = z.object({ title: z.string().trim().min(1).max(300), source: z.string().trim().min(1).max(120), price: z.number().finite().positive(), link: z.url({ protocol: /^https?$/ }) });
export type Offer = z.infer<typeof OfferSchema> & { currency: 'INR'; sourceDomain: string; thumbnail?: string };

/** SerpApi shopping_results → validated offers. Anything without a title, seller, positive price and http(s) link is dropped. */
export function normalizeOffers(results: unknown): { offers: Offer[]; rejected: number } {
  const raw = Array.isArray(results) ? results : [];
  const offers = raw.flatMap((x: any) => {
    const r = OfferSchema.safeParse({ title: x?.title, source: x?.source, price: x?.extracted_price, link: x?.link ?? x?.product_link });
    return r.success ? [{ ...r.data, currency: 'INR' as const, sourceDomain: new URL(r.data.link).hostname.replace(/^www\./, ''), thumbnail: typeof x.thumbnail === 'string' ? x.thumbnail : undefined }] : [];
  });
  return { offers: offers.slice(0, 20), rejected: raw.length - offers.length };
}

export const serpLive = () => !!env.SERPAPI_API_KEY;
export async function serpShopping(q: string): Promise<{ available: boolean; reason?: string; offers: Offer[]; rejected?: number; query: string }> {
  if (!env.SERPAPI_API_KEY) return { available: false, reason: 'Live supplier search is not configured (no SerpApi key), so this uses only the supplier quotes stored in your database.', offers: [], query: q };
  return span('tool.serpapi', 'serpapi google_shopping', { q }, async set => {
    const u = new URL('https://serpapi.com/search.json');
    Object.entries({ engine: 'google_shopping', q, gl: 'in', hl: 'en', location: 'India', api_key: env.SERPAPI_API_KEY! }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`SerpApi HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.error) throw new Error(`SerpApi: ${j.error}`);
    const { offers, rejected } = normalizeOffers(j.shopping_results);
    set('results', offers.length);
    set('rejected', rejected);
    return { available: true, offers, rejected, query: q };
  });
}

// ---------- Backboard long-term memory ----------

const BB = 'https://app.backboard.io/api';
async function bb(path: string, init: RequestInit = {}) {
  const r = await fetch(BB + path, { ...init, headers: { 'X-API-Key': env.BACKBOARD_API_KEY!, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Backboard HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<any>;
}
async function bbAssistant(): Promise<string> {
  if (env.BACKBOARD_ASSISTANT_ID) return env.BACKBOARD_ASSISTANT_ID;
  const saved = await col.meta.findOne({ _id: 'backboard_assistant' });
  if (saved) return saved.value;
  const a = await bb('/assistants', { method: 'POST', body: JSON.stringify({ name: 'Nivara business memory', system_prompt: 'Stores durable business preferences for a small supplements shop.' }) });
  await col.meta.insertOne({ _id: 'backboard_assistant', value: a.assistant_id });
  return a.assistant_id;
}
export const backboardLive = () => !!env.BACKBOARD_API_KEY;
export async function backboardSave(content: string, metadata: object) {
  return span('memory.backboard', 'backboard add memory', {}, async () => { const r = await bb(`/assistants/${await bbAssistant()}/memories`, { method: 'POST', body: JSON.stringify({ content, metadata }) }); return String(r.id ?? r.memory_id ?? 'ok'); });
}
const contents = (r: any): string[] => (r.memories ?? []).map((m: any) => m.content).filter((c: any) => typeof c === 'string');
export async function backboardList(): Promise<string[]> {
  return span('memory.backboard', 'backboard list memories', {}, async () => contents(await bb(`/assistants/${await bbAssistant()}/memories`)));
}
/** Semantic search over saved memories (POST /assistants/{id}/memories/search). */
export async function backboardSearch(query: string, limit = 10): Promise<string[]> {
  return span('memory.backboard', 'backboard search memories', { limit }, async () => contents(await bb(`/assistants/${await bbAssistant()}/memories/search`, { method: 'POST', body: JSON.stringify({ query, limit }) })));
}

// ---------- ElevenLabs voice ----------

export const elevenLive = () => !!env.ELEVENLABS_API_KEY;
let elevenCheck = { at: 0, key: '', ok: false, detail: '' };
/** Key present AND accepted by ElevenLabs (GET /v1/user, cached 10 min). Only then does the UI say "Voice: ElevenLabs". */
export async function elevenStatus() {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, detail: 'ELEVENLABS_API_KEY missing — browser Web Speech API' };
  if (elevenCheck.key !== key || Date.now() - elevenCheck.at > 600_000) {
    const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(5000) }).catch((e: Error) => e);
    elevenCheck = { at: Date.now(), key, ok: r instanceof Response && r.ok, detail: r instanceof Response ? (r.ok ? 'key verified (GET /v1/user) — Scribe STT + TTS' : `key rejected (HTTP ${r.status}) — browser speech`) : `unreachable (${r.message}) — browser speech` };
  }
  return { ok: elevenCheck.ok, detail: elevenCheck.detail };
}
const AUDIO_EXT: Record<string, string> = { 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' };
export const audioFilename = (mime: string) => `audio.${AUDIO_EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'webm'}`;
export async function elevenSTT(audio: Buffer, mime: string): Promise<string> {
  return span('voice.stt', 'elevenlabs scribe', { bytes: audio.length, mime }, async () => {
    const fd = new FormData();
    fd.append('model_id', env.ELEVENLABS_STT_MODEL ?? 'scribe_v1');
    fd.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] }), audioFilename(mime));
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY! }, body: fd, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`ElevenLabs STT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as any).text ?? '';
  });
}
export async function elevenTTS(text: string): Promise<ArrayBuffer> {
  return span('voice.tts', 'elevenlabs tts', { chars: text.length }, async () => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2500), model_id: env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5' }), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`ElevenLabs TTS HTTP ${r.status}`);
    return r.arrayBuffer();
  });
}
