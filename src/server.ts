import './instrument.ts'; // same init as `node --import`; no-op if that preload already ran or SENTRY_DSN is unset
import * as Sentry from '@sentry/node';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Client, Connection } from '@temporalio/client';
import { client as mongo, col, today, TZ } from './db.ts';
import { OrderInput, attention, morningDue } from './logic.ts';
import { ask, extractOrder, llmStatus } from './agent.ts';
import { backboardLive, elevenLive, elevenStatus, elevenSTT, elevenTTS, llmModel, log, serpLive, traced } from './integrations.ts';
import { AppError, errorResponse, fail } from './errors.ts';
import * as pub from './present.ts';
import * as ops from './ops.ts';
import * as acts from './temporal/activities.ts';
import { seed } from './seed.ts';
import { searchCatalog, tigerStatus } from './tiger.ts';
import { displayName } from './copy.ts';
import { startOrderChangeStream, syncDeliveredOrder } from './sync.ts';

export const app = express();
export default app;
app.use(express.json({ limit: '100kb' }));
// Static files. index.html is built once at start with ?v=<content hash> on its scripts and stylesheet, so the browser
// keeps those for a year and still picks up a deploy; index.html itself is checked every visit. Fonts never change.
const PUBLIC = new URL('../public/', import.meta.url);
const YEAR = 'public, max-age=31536000, immutable';
const hashed = (f: string) => createHash('sha256').update(readFileSync(new URL(f, PUBLIC))).digest('hex').slice(0, 10);
const indexHtml = readFileSync(new URL('index.html', PUBLIC), 'utf8').replace(/(src|href)="([\w-]+\.(?:js|css))"/g, (_m, a, f) => `${a}="${f}?v=${hashed(f)}"`);
app.get(['/', '/index.html'], (_q, s) => { s.set('Cache-Control', 'no-cache').type('html').send(indexHtml); });
app.use(express.static(fileURLToPath(PUBLIC), { index: false, setHeaders: (s, path) => s.setHeader('Cache-Control', /[\\/]fonts[\\/]/.test(path) || /[?&]v=/.test(s.req.url ?? '') ? YEAR : 'no-cache') }));
/** Validate input; the owner sees `message`, the log gets zod's detail. */
const body = <T extends z.ZodTypeAny>(s: T, b: unknown, message = "That request didn't look right. Check it and try again."): z.infer<T> => {
  const r = s.safeParse(b);
  if (!r.success) throw fail('invalid_input', message, 400, z.prettifyError(r.error));
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
  } catch (e: any) { temporal.error = e.message; log.warn({ err: e.message }, 'Temporal not reachable; jobs run in-process'); }
  return temporal.client;
}
// Phases run in order; the steps inside a phase are independent and run in parallel (mirrors temporal/workflows.ts).
// The brief reads the fresh forecast but not live prices, so it runs alongside the SerpApi refresh.
const WORKFLOWS = {
  dailyBriefWorkflow: [['forecast'], ['lowStockCheck', 'supplierRefresh', 'dailyBrief']],
  lowStockWorkflow: [['lowStockCheck']], forecastWorkflow: [['forecast']], supplierRefreshWorkflow: [['supplierRefresh']],
} as const;
type WF = keyof typeof WORKFLOWS;
/** Keep below the web client's request timeout so a slow worker reads "still running", not a timeout. */
const WORKFLOW_WAIT_MS = Number(process.env.WORKFLOW_WAIT_MS) || 40_000;

/** Fallback when Temporal is down: same activities, in-process, with a small retry loop. Clearly labelled. */
async function runDirect(name: WF) {
  const result: Record<string, any> = {}, retries: string[] = [];
  const runStep = async (step: string) => {
    for (let attempt = 1; ; attempt++) {
      try { result[step] = step === 'supplierRefresh' ? await acts.supplierRefresh(attempt) : await (acts as any)[step](); return; }
      catch (e: any) {
        retries.push(`${step} attempt ${attempt}: ${e.message}`);
        if (attempt >= 5) { if (step === 'supplierRefresh' && name === 'dailyBriefWorkflow') { result[step] = { error: e.message }; return; } throw e; }
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  };
  for (const phase of WORKFLOWS[name]) await Promise.all(phase.map(runStep));
  return { mode: 'direct' as const, runner: 'direct-fallback (Temporal unavailable)', result, retries };
}

// ---------- routes ----------
const r = express.Router();

r.get('/health', async (_q, s) => {
  const [llm, t, mongoOk, lastForecast, voice, tiger] = await Promise.all([
    llmStatus(), getTemporal(),
    mongo.db().admin().ping().then(() => true, () => false),
    col.forecasts.findOne({}, { sort: { createdAt: -1 } }).catch(() => null),
    elevenStatus(),
    tigerStatus(),
  ]);
  s.json(pub.publicHealth({
    date: today(), mongo: mongoOk, gemma: llm.reachable, mastra: llm.reachable && llm.nativeTools, forecast: lastForecast, tiger: tiger.live,
    serpapi: serpLive(), backboard: backboardLive(), elevenlabs: voice.ok, temporal: !!t, sentry: !!Sentry.getClient(),
    model: llm.reachable ? llmModel() : undefined, render: !!process.env.RENDER,
  }));
});

/** Deterministic only (Mongo + latest cached forecast): never waits on Gemma or TabPFN. */
r.get('/dashboard', async (_q, s) => {
  const [inv, pending, opp, brief, demo, live] = await Promise.all([ops.getInventory({ latest: true }), ops.getPendingOrders(), ops.supplierOpportunities(), col.briefs.findOne({}, { sort: { createdAt: -1 } }), col.products.findOne({ demo: true }), ops.livePrices()]);
  const hour = +new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ });
  s.json({
    date: today(), greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    attention: attention(inv.items, pending.orders, opp, today()),
    brief: pub.publicBrief(brief), forecast: { date: inv.forecastDate }, highPriority: inv.lowStock.map(pub.publicStockItem),
    pending: { today: pending.today, orders: pending.orders.map(pub.publicOrder) }, opportunities: opp.map(pub.publicOpportunity), supplierThreshold: ops.supplierThreshold,
    livePrices: live.map(pub.publicLivePrice), onlinePrices: serpLive(), demo: !!demo,
  });
});

r.get('/inventory', async (_q, s) => s.json({ products: (await col.products.find().sort({ _id: 1 }).toArray()).map(pub.publicProduct) }));
r.get('/forecast', async (q, s) => s.json(pub.publicForecast(await ops.forecastDemand({ force: q.query.force === '1' }))));
r.get('/orders', async (_q, s) => s.json({ orders: (await col.orders.find().sort({ createdAt: -1 }).limit(100).toArray()).map(pub.publicOrder) }));
r.get('/suppliers', async (_q, s) => s.json({ suppliers: (await col.suppliers.find().toArray()).map(x => ({ _id: x._id, name: displayName(x.name) })), opportunities: (await ops.supplierOpportunities()).map(pub.publicOpportunity) }));
r.get('/suppliers/search', async (q, s) => s.json(pub.publicSearch(await ops.searchSupplierPrices(body(z.string().trim().min(2).max(80), q.query.q, 'Type a product name to search, at least 2 letters.')))));

r.post('/assistant', async (q, s) => {
  const b = body(z.object({
    message: z.string().trim().min(1).max(500),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(12).default([]),
    conversationId: z.string().trim().min(1).max(80).optional(),
  }), q.body, 'Type a question first, up to 500 characters.');
  s.json(pub.publicAnswer(await ask(b.message, b.history, b.conversationId ?? q.get('x-conversation-id') ?? undefined)));
});

r.get('/catalog/search', async (q, s) => s.json(pub.publicCatalog(await searchCatalog(body(z.string().trim().min(2).max(120), q.query.q, 'Type a product to search, at least 2 letters.')))));

r.post('/orders/extract', async (q, s) => s.json(pub.publicDraft(await extractOrder(body(z.object({ text: z.string().trim().min(3).max(500) }), q.body, 'Paste the order message first, up to 500 characters.').text))));

/** The ONLY order write path: deterministic, validated, every SKU must exist. */
r.post('/orders', async (q, s) => {
  const o = body(OrderInput, q.body, 'Some order details are missing. Check the customer and products, then try again.');
  const products = await col.products.find({ _id: { $in: o.items.map(i => i.sku) } }).toArray();
  const missing = o.items.filter(i => !products.some(p => p._id === i.sku));
  if (missing.length) throw fail('unknown_product', "One of those products isn't in your stock list any more. Read the message again.", 400, `unknown sku ${missing.map(m => m.sku).join(',')}`);
  let customerId = o.customerId;
  if (customerId && !(await col.customers.findOne({ _id: customerId }))) throw fail('unknown_customer', "That customer isn't in your records any more. Read the message again.", 400);
  if (!customerId) { customerId = 'C' + randomUUID().slice(0, 8); await col.customers.insertOne({ _id: customerId, name: o.customerName, channel: 'whatsapp' }); }
  const items = o.items.map(i => { const p = products.find(p => p._id === i.sku)!; return { sku: p._id, name: p.name, quantity: i.quantity, price: p.price }; });
  const order = { _id: 'O' + Date.now().toString(36).toUpperCase(), no: await ops.nextOrderNo(), customerId, customerName: o.customerName, items, total: items.reduce((a, i) => a + i.price * i.quantity, 0), status: 'pending' as const, deliveryDate: o.deliveryDate ?? null, createdAt: new Date(), source: 'assistant-extraction' };
  await col.orders.insertOne(order);
  await ops.invalidateDay(); // reserved stock changed → recompute plan and brief
  s.status(201).json(pub.publicOrder(order));
});

/** Deliver: decrement stock, record Atlas sale, upsert into Tiger analytics (idempotent by orderId). */
r.post('/orders/:id/deliver', async (q, s) => {
  const deliveredAt = new Date();
  const o = await col.orders.findOneAndUpdate({ _id: q.params.id, status: 'pending' }, { $set: { status: 'delivered', deliveredAt } }, { returnDocument: 'after' });
  if (!o) throw fail('order_not_pending', 'That order is already delivered or no longer exists.', 404);
  for (const i of o.items) {
    await col.products.updateOne({ _id: i.sku }, { $inc: { stock: -i.quantity } });
    await col.sales.updateOne({ sku: i.sku, date: today() }, { $inc: { qty: i.quantity }, $set: { source: 'order' } }, { upsert: true });
  }
  await ops.invalidateDay();
  await syncDeliveredOrder({ ...o, deliveredAt }).catch((e: any) => log.warn({ err: e.message }, 'delivered-order analytics sync failed'));
  s.json(pub.publicOrder(o));
});

r.get('/memory', async (_q, s) => s.json(pub.publicMemory(await ops.getMemory())));
r.post('/memory', async (q, s) => {
  const m = await ops.saveMemory(body(z.object({ text: z.string().trim().min(3).max(300) }), q.body, 'Type what to remember, at least 3 letters.').text);
  s.json({ saved: pub.publicMemory({ preferences: [m.saved] }).preferences[0], note: m.note });
});

// Voice failures are quiet: a short envelope plus a `fallback` hint, and the browser's own speech takes over.
const VOICE_OFF = { code: 'voice_unavailable', message: "Voice isn't available right now. You can type instead." };
const voiceFail = (s: express.Response, status: number, fallback: string, extra: object = {}) => s.status(status).json({ error: VOICE_OFF, fallback, ...extra });
const audio = (q: express.Request) => {
  if (!Buffer.isBuffer(q.body) || !q.body.length) throw fail('no_audio', "We didn't get any sound. Try recording again.", 400);
  return q.body;
};
r.post('/voice/stt', express.raw({ type: 'audio/*', limit: '10mb' }), async (q, s) => {
  if (!elevenLive()) return voiceFail(s, 501, 'browser-web-speech');
  const bytes = audio(q);
  try { s.json({ text: await elevenSTT(bytes, q.get('content-type') ?? 'audio/webm') }); }
  catch (e: any) { log.warn({ err: e.message }, 'ElevenLabs STT failed'); voiceFail(s, 502, 'browser-web-speech'); }
});

/** WhatsApp voice note → ElevenLabs Scribe (Hindi/Hinglish) → Gemma order extraction → draft (not auto-written). */
r.post('/voice/order', express.raw({ type: 'audio/*', limit: '10mb' }), async (q, s) => {
  if (!elevenLive()) return voiceFail(s, 501, 'browser-web-speech');
  const bytes = audio(q);
  let text: string;
  try { text = await elevenSTT(bytes, q.get('content-type') ?? 'audio/webm'); }
  catch (e: any) { log.warn({ err: e.message }, 'ElevenLabs STT failed'); return voiceFail(s, 502, 'browser-web-speech'); }
  if (!text.trim()) return s.status(422).json({ error: { code: 'no_speech', message: "We couldn't hear any words. Try again a little closer to the mic." }, text });
  try {
    s.json({ text, ...pub.publicDraft(await extractOrder(text)), note: 'Draft only. Check it, then confirm to save.' });
  } catch (e: any) {
    log.warn({ err: e.message }, 'voice order extraction failed');
    const { status, body } = errorResponse(e);
    s.status(status).json({ text, ...body });
  }
});
r.post('/voice/tts', async (q, s) => {
  if (!elevenLive()) return voiceFail(s, 501, 'browser-speech-synthesis');
  const { text } = body(z.object({ text: z.string().trim().min(1).max(2500) }), q.body, 'Nothing to read aloud.');
  try { s.type('audio/mpeg').send(Buffer.from(await elevenTTS(text))); }
  catch (e: any) { log.warn({ err: e.message }, 'ElevenLabs TTS failed'); voiceFail(s, 502, 'browser-speech-synthesis'); }
});

r.post('/workflows/:name/run', async (q, s) => {
  const name = body(z.enum(Object.keys(WORKFLOWS) as [WF, ...WF[]]), q.params.name, "That job doesn't exist.");
  const t = await getTemporal();
  if (!t) return s.json(pub.publicRun(name, await traced(`workflow.${name}`, {}, () => runDirect(name))));
  const h = await t.workflow.start(name, { taskQueue: 'nivara', workflowId: `${name}-${Date.now()}` });
  const out = await Promise.race([h.result(), new Promise(res => setTimeout(() => res(null), WORKFLOW_WAIT_MS))]);
  const steps = WORKFLOWS[name].flat();
  const result = out && steps.length === 1 ? { [steps[0]]: out } : out; // same { step: output } shape as runDirect
  if (!result) log.warn({ workflowId: h.workflowId, waitMs: WORKFLOW_WAIT_MS }, 'workflow still running; is the worker up?');
  s.json(pub.publicRun(name, { result }));
});
r.get('/workflows', async (_q, s) => {
  const t = await getTemporal();
  let runs: any[] = [], schedule: any = null;
  if (t) {
    for await (const w of t.workflow.list({ query: 'TaskQueue = "nivara"', pageSize: 10 })) { runs.push({ id: w.workflowId, type: w.type, status: w.status.name, start: w.startTime }); if (runs.length >= 10) break; }
    schedule = await t.schedule.getHandle('daily-brief').describe().then(d => ({ id: 'daily-brief', next: d.info.nextActionTimes?.[0], recent: d.info.recentActions?.length }), () => null);
  }
  s.json(pub.publicWorkflows({ runs, schedule, briefs: await col.briefs.find().sort({ createdAt: -1 }).limit(5).toArray() }));
});

r.get('/traces', async (_q, s) => s.json({ activity: (await col.traces.find({}, { projection: { output: 0 } }).sort({ at: -1 }).limit(50).toArray()).map(pub.publicActivity) }));
r.all('/{*any}', () => { throw fail('not_found', "We couldn't find that.", 404); });

app.use('/api', r);
Sentry.setupExpressErrorHandler(app); // captures 5xx; no-op without SENTRY_DSN
app.use((e: any, q: express.Request, s: express.Response, _n: express.NextFunction) => {
  const { status, body } = errorResponse(e);
  // full detail stays server-side (log + Sentry); the response carries only the friendly envelope
  if (status >= 500) log.error({ err: e?.message, stack: e?.stack, path: q.path }, 'request failed');
  else log.warn({ code: body.error.code, detail: e instanceof AppError ? e.detail : e?.message, path: q.path }, 'request rejected');
  if (s.headersSent) return;
  s.status(status).json(body);
});

if (import.meta.main) {
  // Mongo down at boot: keep serving so /api/health reports it; the driver reconnects on the next query.
  try {
    await mongo.connect();
    if (!(await col.products.countDocuments())) log.info({ seeded: await seed({ online: false }) }, 'empty database → real stand-in seeded');
    log.info(await startOrderChangeStream(), 'Atlas→Tiger order sync');
  } catch (e: any) { log.error({ err: e.message }, 'MongoDB unavailable at boot; check MONGODB_URI'); }
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => log.info(`Nivara on http://localhost:${port}`));
  // No Temporal worker (the free Render host): make the morning brief inside the app once a day from 08:00 shop time.
  const morning = async () => {
    if (await getTemporal()) return; // the Temporal schedule owns it
    const hour = +new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }), day = today();
    const last = (await col.meta.findOne({ _id: 'morningBrief' }).catch(() => null))?.value;
    if (!morningDue(hour, last, day)) return;
    const claimed = await col.meta.updateOne({ _id: 'morningBrief', value: { $ne: day } }, { $set: { value: day } }, { upsert: true }).then(r => r.modifiedCount + r.upsertedCount > 0, () => false);
    if (!claimed) return; // another instance or tick took it
    await traced('workflow.dailyBriefWorkflow', {}, () => runDirect('dailyBriefWorkflow')).then(() => log.info({ day }, 'morning brief made in-app'), (e: any) => log.warn({ err: e.message }, 'in-app morning brief failed'));
  };
  setTimeout(() => morning().catch(() => {}), 20_000);
  setInterval(() => morning().catch(() => {}), 10 * 60_000).unref();
  process.once('SIGTERM', () => server.close(() => Sentry.close(2000).finally(() => process.exit(0))));
}
