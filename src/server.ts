import './instrument.ts'; // same init as `node --import`; no-op if that preload already ran or SENTRY_DSN is unset
import * as Sentry from '@sentry/node';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client, Connection } from '@temporalio/client';
import { client as mongo, col, today, TZ } from './db.ts';
import { OrderInput, attention } from './logic.ts';
import { ask, extractOrder, llmStatus } from './agent.ts';
import { OLLAMA, backboardLive, elevenLive, elevenStatus, elevenSTT, elevenTTS, llmModel, llmProvider, log, serpLive, traced } from './integrations.ts';
import * as ops from './ops.ts';
import * as acts from './temporal/activities.ts';
import { seed } from './seed.ts';

export const app = express();
export default app;
app.use(express.json({ limit: '100kb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { setHeaders: s => s.setHeader('Cache-Control', 'no-cache') }));
const body = <T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> => {
  const r = s.safeParse(b);
  if (!r.success) throw Object.assign(new Error(z.prettifyError(r.error)), { status: 400 });
  return r.data;
};

// ---------- Temporal (optional) ----------
// Unset TEMPORAL_ADDRESS = don't dial. Set it to connect, including localhost:7233.
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS;
let temporal: { client?: Client; at: number; error?: string } = { at: 0 };
async function getTemporal() {
  if (!TEMPORAL_ADDRESS) return undefined;
  if (temporal.client || Date.now() - temporal.at < 15_000) return temporal.client;
  temporal.at = Date.now();
  try {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS, connectTimeout: 1500, ...(process.env.TEMPORAL_API_KEY && { tls: true, apiKey: process.env.TEMPORAL_API_KEY }) });
    temporal = { client: new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' }), at: Date.now() };
  } catch (e: any) { temporal.error = e.message; }
  return temporal.client;
}
const WORKFLOWS = { dailyBriefWorkflow: ['lowStockCheck', 'forecast', 'supplierRefresh', 'dailyBrief'], lowStockWorkflow: ['lowStockCheck'], forecastWorkflow: ['forecast'], supplierRefreshWorkflow: ['supplierRefresh'] } as const;
type WF = keyof typeof WORKFLOWS;

/** Fallback when Temporal is down: same activities, in-process, with a small retry loop. Clearly labelled. */
async function runDirect(name: WF) {
  const result: Record<string, any> = {}, retries: string[] = [];
  for (const step of WORKFLOWS[name]) {
    for (let attempt = 1; ; attempt++) {
      try { result[step] = step === 'supplierRefresh' ? await acts.supplierRefresh(attempt) : await (acts as any)[step](); break; }
      catch (e: any) {
        retries.push(`${step} attempt ${attempt}: ${e.message}`);
        if (attempt >= 5) { if (step === 'supplierRefresh' && name === 'dailyBriefWorkflow') { result[step] = { error: e.message }; break; } throw e; }
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }
  return { runner: 'direct-fallback (Temporal unavailable)', result, retries };
}

// ---------- routes ----------
const r = express.Router();

r.get('/health', async (_q, s) => {
  const [llm, t, mongoOk, lastForecast, voice] = await Promise.all([
    llmStatus(), getTemporal(),
    mongo.db().admin().ping().then(() => true, () => false),
    col.forecasts.findOne({}, { sort: { createdAt: -1 } }).catch(() => null),
    elevenStatus(),
  ]);
  const live = (on: boolean, detail: string) => ({ status: on ? 'live' : 'fallback', detail });
  s.json({
    ok: mongoOk,
    date: today(),
    integrations: {
      mongodb: live(mongoOk, process.env.MONGODB_URI?.includes('mongodb.net') ? 'MongoDB Atlas' : 'local MongoDB'),
      gemma: live(llm.reachable, llmProvider() === 'gemini'
        ? (llm.reachable ? `${llmModel()} via Gemini API (caps: ${llm.capabilities?.join(',')})` : `${llmModel()} unavailable (Gemini API) — keyword router + templates`)
        : (llm.reachable ? `${llmModel()} @ ${OLLAMA} (caps: ${llm.capabilities?.join(',')})` : `${llmModel()} unreachable at ${OLLAMA} — keyword router + templates`)),
      mastra: live(llm.reachable && llm.nativeTools, !llm.reachable ? 'Gemma unreachable — tools run via keyword router' : llm.nativeTools ? 'Mastra agent native tool calling' : 'Mastra tools invoked via Gemma JSON router (model lacks native tool calling)'),
      tabpfn: live(lastForecast?.method === 'tabpfn', lastForecast ? `last forecast: ${lastForecast.method}${lastForecast.fallbackReason ? ` (${lastForecast.fallbackReason.slice(0, 120)})` : ''}` : 'no forecast yet'),
      serpapi: live(serpLive(), serpLive() ? 'key set — Google Shopping via the Temporal supplierRefresh activity (results cached in supplierPrices)' : 'SERPAPI_API_KEY missing — stored supplier quotes only'),
      backboard: live(backboardLive(), backboardLive() ? 'key set — memories saved to and searched in Backboard; Mongo stays source of truth' : 'BACKBOARD_API_KEY missing — memory stored in Mongo only'),
      elevenlabs: live(voice.ok, voice.detail),
      temporal: live(!!t, t ? `connected ${TEMPORAL_ADDRESS}` : TEMPORAL_ADDRESS ? `unreachable ${TEMPORAL_ADDRESS} — workflows run in-process` : 'TEMPORAL_ADDRESS unset — workflows run in-process'),
      sentry: live(!!Sentry.getClient(), Sentry.getClient() ? `SDK initialised — gen_ai spans sent to Sentry (content ${process.env.SENTRY_SEND_CONTENT === '1' ? 'included' : 'redacted'})` : 'SENTRY_DSN missing — local traces only'),
    },
  });
});

/** Deterministic only (Mongo + latest cached forecast): never waits on Gemma or TabPFN. */
r.get('/dashboard', async (_q, s) => {
  const [inv, pending, opp, brief, demo, live] = await Promise.all([ops.getInventory({ latest: true }), ops.getPendingOrders(), ops.supplierOpportunities(), col.briefs.findOne({}, { sort: { createdAt: -1 } }), col.products.findOne({ demo: true }), ops.livePrices()]);
  const hour = +new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ });
  s.json({
    date: today(), greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    attention: attention(inv.items, pending.orders, opp, today()),
    brief, forecast: { method: inv.method, model: inv.model, date: inv.forecastDate }, highPriority: inv.lowStock,
    pending, opportunities: opp, supplierThreshold: ops.supplierThreshold, livePrices: live, serpConfigured: serpLive(), demo: !!demo,
  });
});

r.get('/inventory', async (_q, s) => s.json({ products: await col.products.find().sort({ _id: 1 }).toArray() }));
r.get('/forecast', async (q, s) => s.json(await ops.forecastDemand({ force: q.query.force === '1' })));
r.get('/orders', async (_q, s) => s.json({ orders: await col.orders.find().sort({ createdAt: -1 }).limit(100).toArray() }));
r.get('/suppliers', async (_q, s) => s.json({ suppliers: await col.suppliers.find().toArray(), opportunities: await ops.supplierOpportunities() }));
r.get('/suppliers/search', async (q, s) => s.json(await ops.searchSupplierPrices(body(z.string().trim().min(2).max(80), q.query.q))));

r.post('/assistant', async (q, s) => {
  const b = body(z.object({ message: z.string().trim().min(1).max(500), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(12).default([]) }), q.body);
  s.json(await ask(b.message, b.history));
});

r.post('/orders/extract', async (q, s) => s.json(await extractOrder(body(z.object({ text: z.string().trim().min(3).max(500) }), q.body).text)));

/** The ONLY order write path: deterministic, validated, every SKU must exist. */
r.post('/orders', async (q, s) => {
  const o = body(OrderInput, q.body);
  const products = await col.products.find({ _id: { $in: o.items.map(i => i.sku) } }).toArray();
  const missing = o.items.filter(i => !products.some(p => p._id === i.sku));
  if (missing.length) throw Object.assign(new Error(`Unknown SKU(s): ${missing.map(m => m.sku).join(', ')}`), { status: 400 });
  let customerId = o.customerId;
  if (customerId && !(await col.customers.findOne({ _id: customerId }))) throw Object.assign(new Error('Unknown customerId'), { status: 400 });
  if (!customerId) { customerId = 'C' + randomUUID().slice(0, 8); await col.customers.insertOne({ _id: customerId, name: o.customerName, channel: 'whatsapp' }); }
  const items = o.items.map(i => { const p = products.find(p => p._id === i.sku)!; return { sku: p._id, name: p.name, quantity: i.quantity, price: p.price }; });
  const order = { _id: 'O' + Date.now().toString(36).toUpperCase(), customerId, customerName: o.customerName, items, total: items.reduce((a, i) => a + i.price * i.quantity, 0), status: 'pending' as const, deliveryDate: o.deliveryDate ?? null, createdAt: new Date(), source: 'assistant-extraction' };
  await col.orders.insertOne(order);
  await col.forecasts.deleteMany({ date: today() }); // reserved stock changed → recompute plan
  s.status(201).json(order);
});

/** Deliver: decrement stock and record the sale (feeds future forecasts). */
r.post('/orders/:id/deliver', async (q, s) => {
  const o = await col.orders.findOneAndUpdate({ _id: q.params.id, status: 'pending' }, { $set: { status: 'delivered' } }, { returnDocument: 'after' });
  if (!o) throw Object.assign(new Error('Order not found or not pending'), { status: 404 });
  for (const i of o.items) {
    await col.products.updateOne({ _id: i.sku }, { $inc: { stock: -i.quantity } });
    await col.sales.updateOne({ sku: i.sku, date: today() }, { $inc: { qty: i.quantity } }, { upsert: true });
  }
  await col.forecasts.deleteMany({ date: today() });
  s.json(o);
});

r.get('/memory', async (_q, s) => s.json(await ops.getMemory()));
r.post('/memory', async (q, s) => s.json(await ops.saveMemory(body(z.object({ text: z.string().trim().min(3).max(300) }), q.body).text)));

r.post('/voice/stt', express.raw({ type: 'audio/*', limit: '10mb' }), async (q, s) => {
  if (!elevenLive()) return s.status(501).json({ error: 'ELEVENLABS_API_KEY not set', fallback: 'browser-web-speech' });
  if (!Buffer.isBuffer(q.body) || !q.body.length) throw Object.assign(new Error('Send audio bytes with an audio/* content-type'), { status: 400 });
  try { s.json({ text: await elevenSTT(q.body, q.get('content-type') ?? 'audio/webm') }); }
  catch (e: any) { log.warn({ err: e.message }, 'ElevenLabs STT failed'); s.status(502).json({ error: e.message, fallback: 'browser-web-speech' }); }
});
r.post('/voice/tts', async (q, s) => {
  if (!elevenLive()) return s.status(501).json({ error: 'ELEVENLABS_API_KEY not set', fallback: 'browser-speech-synthesis' });
  const { text } = body(z.object({ text: z.string().trim().min(1).max(2500) }), q.body);
  try { s.type('audio/mpeg').send(Buffer.from(await elevenTTS(text))); }
  catch (e: any) { log.warn({ err: e.message }, 'ElevenLabs TTS failed'); s.status(502).json({ error: e.message, fallback: 'browser-speech-synthesis' }); }
});

r.post('/workflows/:name/run', async (q, s) => {
  const name = body(z.enum(Object.keys(WORKFLOWS) as [WF, ...WF[]]), q.params.name);
  const t = await getTemporal();
  if (!t) return s.json(await traced(`workflow.${name}`, {}, () => runDirect(name)));
  const h = await t.workflow.start(name, { taskQueue: 'nivara', workflowId: `${name}-${Date.now()}` });
  const result = await Promise.race([h.result(), new Promise(res => setTimeout(() => res(null), 120_000))]);
  s.json({ runner: 'temporal', workflowId: h.workflowId, runId: h.firstExecutionRunId, result, note: result ? undefined : 'Still running after 120s — is `npm run worker` up? Check the Temporal UI.' });
});
r.get('/workflows', async (_q, s) => {
  const t = await getTemporal();
  let runs: any[] = [], schedule: any = null;
  if (t) {
    for await (const w of t.workflow.list({ query: 'TaskQueue = "nivara"', pageSize: 10 })) { runs.push({ id: w.workflowId, type: w.type, status: w.status.name, start: w.startTime }); if (runs.length >= 10) break; }
    schedule = await t.schedule.getHandle('daily-brief').describe().then(d => ({ id: 'daily-brief', next: d.info.nextActionTimes?.[0], recent: d.info.recentActions?.length }), () => null);
  }
  s.json({ temporal: !!t, uiUrl: t ? process.env.TEMPORAL_UI_URL ?? 'http://localhost:8233' : null, runs, schedule, briefs: await col.briefs.find().sort({ createdAt: -1 }).limit(5).toArray() });
});

r.get('/traces', async (_q, s) => s.json({ traces: await col.traces.find({}, { projection: { spans: 0 } }).sort({ at: -1 }).limit(50).toArray() }));
r.get('/traces/:id', async (q, s) => s.json(await col.traces.findOne({ _id: q.params.id }) ?? {}));

app.use('/api', r);
Sentry.setupExpressErrorHandler(app); // captures 5xx; no-op without SENTRY_DSN
app.use((e: any, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
  const status = e.status ?? 500;
  if (status >= 500) log.error({ err: e.message, stack: e.stack }, 'request failed'); else log.warn({ err: e.message }, 'bad request');
  s.status(status).json({ error: e.message });
});

if (import.meta.main) {
  await mongo.connect();
  if (!(await col.products.countDocuments())) log.info({ seeded: await seed() }, 'empty database → demo data seeded');
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => log.info(`Nivara on http://localhost:${port}`));
  process.once('SIGTERM', () => server.close(() => Sentry.close(2000).finally(() => process.exit(0))));
}
