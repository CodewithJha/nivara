import * as Sentry from '@sentry/node';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client, Connection } from '@temporalio/client';
import { client as mongo, col, today, TZ } from './db.ts';
import { OrderInput, attention } from './logic.ts';
import { ask, extractOrder, llmStatus } from './agent.ts';
import { MODEL, OLLAMA, backboardLive, elevenLive, elevenStatus, elevenSTT, elevenTTS, log, serpLive, traced } from './integrations.ts';
import * as ops from './ops.ts';
import * as acts from './temporal/activities.ts';
import { seed } from './seed.ts';

export const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { setHeaders: s => s.setHeader('Cache-Control', 'no-cache') }));
const body = <T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> => {
  const r = s.safeParse(b);
  if (!r.success) throw Object.assign(new Error(z.prettifyError(r.error)), { status: 400 });
  return r.data;
};

// ---------- Temporal (optional) ----------
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
let temporal: { client?: Client; at: number; error?: string } = { at: 0 };
async function getTemporal() {
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
      gemma: live(llm.reachable, llm.reachable ? `${MODEL} @ ${OLLAMA} (caps: ${llm.capabilities?.join(',')})` : `${MODEL} unreachable at ${OLLAMA} — keyword router + templates`),
      mastra: live(llm.reachable && llm.nativeTools, !llm.reachable ? 'Gemma unreachable — tools run via keyword router' : llm.nativeTools ? 'Mastra agent native tool calling' : 'Mastra tools invoked via Gemma JSON router (model lacks native tool calling)'),
      tabpfn: live(lastForecast?.method === 'tabpfn', lastForecast ? `last forecast: ${lastForecast.method}${lastForecast.fallbackReason ? ` (${lastForecast.fallbackReason.slice(0, 120)})` : ''}` : 'no forecast yet'),
      serpapi: live(serpLive(), serpLive() ? 'key set — Google Shopping via the Temporal supplierRefresh activity (results cached in supplierPrices)' : 'SERPAPI_API_KEY missing — stored supplier quotes only'),
      backboard: live(backboardLive(), backboardLive() ? 'key set — memories saved to and searched in Backboard; Mongo stays source of truth' : 'BACKBOARD_API_KEY missing — memory stored in Mongo only'),
      elevenlabs: live(voice.ok, voice.detail),
      temporal: live(!!t, t ? `connected ${TEMPORAL_ADDRESS}` : `unreachable ${TEMPORAL_ADDRESS} — workflows run in-process`),
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
