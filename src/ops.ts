// Business operations. Deterministic. These are the agent's tools AND the Temporal activities.
import { col, daysAgo, today, type Preference } from './db.ts';
import { MIN_SUPPLIER_SAVING_PERCENT, MIN_SUPPLIER_SAVING_RUPEES, bestQuote, blockTarget, inr, looksClean, matchProduct, methodLabel, movingAverage7, orderFlag, shortDate, stockPlan } from './logic.ts';
import { backboardLive, backboardList, backboardSave, backboardSearch, gemma, log, serpLive, serpShopping, span, tabpfnForecast } from './integrations.ts';

const HISTORY_DAYS = 60;

async function reservedBySku() {
  const r: Record<string, number> = {};
  for (const o of await col.orders.find({ status: 'pending' }).toArray()) for (const i of o.items) r[i.sku] = (r[i.sku] ?? 0) + i.quantity;
  return r;
}

/** Forecast 7-day demand per product. TabPFN if it runs, else labelled moving average. Cached per day. */
export async function forecastDemand({ force = false, latest = false } = {}) {
  const t = today();
  if (!force) {
    // latest: any date, so the dashboard never waits ~90s on TabPFN; callers show the forecast date
    const cached = await col.forecasts.findOne(latest ? {} : { date: t }, { sort: { createdAt: -1 } });
    // stock rules re-applied so cached docs follow the current logic.ts
    if (cached) return { ...cached, items: cached.items.map((i: any) => ({ ...i, ...stockPlan(i) })) };
  }
  return span('gen_ai.execute_tool', 'execute_tool forecast_demand', { 'gen_ai.tool.name': 'forecast_demand' }, async set => {
    const since = daysAgo(HISTORY_DAYS, t);
    const rows = await col.sales.find({ date: { $gte: since, $lt: t } }).toArray();
    const products = await col.products.find().toArray();
    const series: Record<string, number[]> = {};
    for (const p of products) {
      const byDate = new Map(rows.filter(r => r.sku === p._id).map(r => [r.date, r.qty]));
      series[p._id] = Array.from({ length: HISTORY_DAYS }, (_, i) => byDate.get(daysAgo(HISTORY_DAYS - i, t)) ?? 0);
    }
    let method: 'tabpfn' | 'fallback-moving-average' = 'tabpfn', reason: string | undefined, pred: Record<string, number>, model: string | undefined;
    try { ({ pred, model } = await tabpfnForecast(series)); }
    catch (e: any) {
      method = 'fallback-moving-average'; reason = e.message;
      log.warn({ err: e.message }, 'TabPFN unavailable, using moving average');
      pred = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, movingAverage7(v)]));
    }
    const reserved = await reservedBySku();
    const items = products.map(p => {
      const demand7 = Math.round((pred[p._id] ?? 0) * 10) / 10;
      const last7 = series[p._id].slice(-7).reduce((a, b) => a + b, 0);
      return { sku: p._id, name: p.name, stock: p.stock, reserved: reserved[p._id] ?? 0, leadTimeDays: p.leadTimeDays, last7Sold: last7, demand7, ...stockPlan({ stock: p.stock, reserved: reserved[p._id] ?? 0, demand7, leadTimeDays: p.leadTimeDays }) };
    }).sort((a, b) => ['high', 'medium', 'low'].indexOf(a.risk) - ['high', 'medium', 'low'].indexOf(b.risk) || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
    const doc = { date: t, method, model: model && `TabPFN ${model}`, fallbackReason: reason, historyDays: HISTORY_DAYS, items, createdAt: new Date() };
    await col.forecasts.insertOne(doc);
    set('method', method);
    return doc;
  });
}

export async function getInventory(opts: { latest?: boolean } = {}) {
  const f = await forecastDemand(opts);
  return { method: f.method, model: f.model, forecastDate: f.date, items: f.items, lowStock: f.items.filter((i: any) => i.risk !== 'low') };
}

export async function getPendingOrders() {
  const t = today();
  const orders = (await col.orders.find({ status: 'pending' }).toArray()).sort((a, b) => (a.deliveryDate ?? '~').localeCompare(b.deliveryDate ?? '~'));
  return { today: t, orders: orders.map(o => ({ ...o, overdue: !!o.deliveryDate && o.deliveryDate < t, dueToday: o.deliveryDate === t, flag: orderFlag(o.deliveryDate, t) })) };
}

export async function salesSummary(days = 7) {
  const since = daysAgo(days);
  const agg = await col.sales.aggregate<{ _id: string; qty: number }>([{ $match: { date: { $gte: since } } }, { $group: { _id: '$sku', qty: { $sum: '$qty' } } }, { $sort: { qty: -1 } }]).toArray();
  const names = Object.fromEntries((await col.products.find().toArray()).map(p => [p._id, p]));
  return { since, days, top: agg.map(a => ({ sku: a._id, name: names[a._id]?.name, qty: a.qty, revenue: a.qty * (names[a._id]?.price ?? 0) })) };
}

// ---------- memory ----------

export async function getMemory() {
  const local = await col.preferences.find().sort({ createdAt: -1 }).toArray();
  let backboard: { live: boolean; memories?: string[]; error?: string } = { live: false };
  if (backboardLive()) try { backboard = { live: true, memories: await backboardList() }; } catch (e: any) { backboard = { live: false, error: e.message }; }
  return { source: 'mongo (source of truth)', preferences: local, backboard };
}

/** Save a preference. Mongo is the source of truth (structured rules like block_supplier); Backboard gets the owner's words. */
export async function saveMemory(text: string) {
  const b = blockTarget(text, await col.suppliers.find().toArray());
  const pref: Preference = { text, kind: b ? 'block_supplier' : 'note', supplier: b?.supplier?.name ?? b?.target, createdAt: new Date(), mirror: 'local-only' };
  let backboardError: string | undefined;
  if (backboardLive()) try { pref.backboardId = await backboardSave(text, { kind: pref.kind, supplier: pref.supplier }); pref.mirror = 'backboard'; }
  catch (e: any) { backboardError = e.message; log.warn({ err: e.message }, 'Backboard save failed; kept in Mongo only'); }
  await col.preferences.insertOne(pref);
  return { saved: pref, matchedSupplier: !!b?.supplier, backboardError, note: b && !b.supplier ? `No supplier named "${b.target}" in your records; saved as a block anyway.` : undefined };
}

/**
 * Blocked supplier names (lowercase). Mongo block rules always apply. With recall (assistant supplier decisions),
 * Backboard memories are searched too and any "don't buy from X" found there is honoured. Backboard down → Mongo only, labelled.
 */
async function blockedSuppliers(recall = false) {
  const blocked = (await col.preferences.find({ kind: 'block_supplier' }).toArray()).map(p => (p.supplier ?? '').toLowerCase()).filter(Boolean);
  if (!recall || !backboardLive()) return { blocked, memorySource: backboardLive() ? 'mongo' : 'mongo only (Backboard not configured)', recalled: [] as string[] };
  try {
    const recalled = await backboardSearch('suppliers the owner does not buy from');
    const suppliers = await col.suppliers.find().toArray();
    const fromBackboard = recalled.flatMap(t => { const b = blockTarget(t, suppliers); return b ? [(b.supplier?.name ?? b.target).toLowerCase()] : []; });
    return { blocked: [...new Set([...blocked, ...fromBackboard])], memorySource: 'mongo + backboard', recalled };
  } catch (e: any) { return { blocked, memorySource: `mongo only (Backboard unavailable: ${e.message.slice(0, 120)})`, recalled: [] as string[] }; }
}
const isBlocked = (name: string, blocked: string[]) => blocked.some(b => name.toLowerCase().includes(b) || b.includes(name.toLowerCase()));
