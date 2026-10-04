// Every external dependency lives here, each with an explicit "is it live?" check and a fallback.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';
import pino from 'pino';
import { z } from 'zod';
import { col } from './db.ts';

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const env = process.env;

export const OLLAMA = (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
export const MODEL = env.GEMMA_MODEL ?? 'gemma3:4b';

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
    out = await run.run(ctx, () => span('gen_ai.invoke_agent', `invoke_agent ${kind}`, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': `nivara.${kind}`, 'gen_ai.request.model': MODEL }, fn));
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

// ---------- Gemma via Ollama's OpenAI-compatible API ----------

export async function gemma(messages: { role: string; content: string }[], opts: { json?: boolean; timeoutMs?: number } = {}): Promise<string> {
  return span('gen_ai.chat', `chat ${MODEL}`, { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'ollama', 'gen_ai.request.model': MODEL, 'gen_ai.request.messages': clip(messages) }, async set => {
    const unavailable = (why: string) => Object.assign(new Error(`Gemma (${MODEL}) unavailable at ${OLLAMA}: ${why}`), { status: 503 });
    const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.OLLAMA_API_KEY && { authorization: `Bearer ${env.OLLAMA_API_KEY}` }) },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, ...(opts.json && { response_format: { type: 'json_object' } }) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    }).catch(e => { throw unavailable(e.message); });
    if (!r.ok) throw unavailable(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const text = j.choices?.[0]?.message?.content ?? '';
    set('gen_ai.response.text', text);
    set('gen_ai.usage.input_tokens', j.usage?.prompt_tokens);
    set('gen_ai.usage.output_tokens', j.usage?.completion_tokens);
    return text;
  });
}

/** Parse model JSON leniently (strip ```fences```), then the caller validates with zod. */
export const parseJson = (s: string) => JSON.parse(s.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, ''));

/** Ollama model capabilities, e.g. ['completion','vision','tools']; null if Ollama unreachable. */
export async function gemmaCapabilities(): Promise<string[] | null> {
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: MODEL }), signal: AbortSignal.timeout(3000) });
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
