// Business operations. Deterministic. These are the agent's tools AND the Temporal activities.
import { col, daysAgo, today, type Preference } from './db.ts';
import { MIN_SUPPLIER_SAVING_PERCENT, MIN_SUPPLIER_SAVING_RUPEES, bestQuote, blockTarget, inr, looksClean, matchProduct, methodLabel, movingAverage7, orderFlag, shortDate, stockPlan } from './logic.ts';
import { backboardLive, backboardList, backboardSave, backboardSearch, gemma, log, serpLive, serpShopping, span, tabpfnForecast } from './integrations.ts';
import { tigerDemand } from './tiger.ts';

const HISTORY_DAYS = 60;
const BRIEF_MAX_TOKENS = Number(process.env.BRIEF_MAX_TOKENS) || 160; // the summary is kept only if ≤ 400 chars

/** Flag days whose qty is > mean + 2σ over the series (simple anomaly marker for the forecast tool). */
export function anomalyFlags(daily: number[]): { index: number; qty: number; z: number }[] {
  if (daily.length < 7) return [];
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length) || 0;
  if (sd === 0) return [];
  return daily.flatMap((qty, index) => {
    const z = (qty - mean) / sd;
    return z >= 2 ? [{ index, qty, z: Math.round(z * 10) / 10 }] : [];
  }).slice(-5);
}

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
    const [rows, products, reserved, tiger, proxy] = await Promise.all([
      col.sales.find({ date: { $gte: since, $lt: t } }).toArray(), col.products.find().toArray(),
      reservedBySku(), tigerDemand(), col.sales.findOne({ source: 'proxy' }),
    ]);
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
    const items = products.map(p => {
      // TabPFN/MA = forward 7d demand for stock plan; Tiger caggs = realised 7d/28d that calibrate the brief/agent
      const forecast7 = Math.round((pred[p._id] ?? 0) * 10) / 10;
      const demand7 = Math.round((tiger[p._id]?.demand7 ?? forecast7) * 10) / 10;
      const last7 = series[p._id].slice(-7).reduce((a, b) => a + b, 0);
      const anomalies = anomalyFlags(series[p._id]);
      return {
        sku: p._id, name: p.name, stock: p.stock, reserved: reserved[p._id] ?? 0, leadTimeDays: p.leadTimeDays,
        last7Sold: last7, forecast7, demand7, demand28: tiger[p._id]?.demand28, anomalies,
        tiger: !!tiger[p._id],
        ...stockPlan({ stock: p.stock, reserved: reserved[p._id] ?? 0, demand7: forecast7, leadTimeDays: p.leadTimeDays }),
      };
    }).sort((a, b) => ['high', 'medium', 'low'].indexOf(a.risk) - ['high', 'medium', 'low'].indexOf(b.risk) || (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
    const doc = {
      date: t, method, model: model && `TabPFN ${model}`, fallbackReason: reason, historyDays: HISTORY_DAYS,
      tigerAggregates: Object.keys(tiger).length > 0,
      demandSource: proxy ? 'proxy' : 'orders',
      demandNote: proxy ? 'Demand: search-interest proxy, not real sales' : undefined,
      items, createdAt: new Date(),
    };
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

// ---------- suppliers ----------

export const supplierThreshold = { rupees: MIN_SUPPLIER_SAVING_RUPEES, percent: MIN_SUPPLIER_SAVING_PERCENT };

/** Cheaper stored quotes vs current cost, skipping blocked suppliers. Significant ones first; only those count for attention. */
export async function supplierOpportunities(blockedList?: string[]) {
  const [products, suppliers] = await Promise.all([col.products.find().toArray(), col.suppliers.find().toArray()]);
  const blocked = blockedList ?? (await blockedSuppliers()).blocked;
  const out = [];
  for (const p of products) {
    const quotes = suppliers.filter(s => s._id !== p.supplierId).flatMap(s => s.quotes.filter(q => q.sku === p._id).map(q => ({ supplier: s.name, supplierId: s._id, unitCost: q.unitCost, blocked: isBlocked(s.name, blocked) })));
    const q = bestQuote(p.cost, quotes);
    if (q) out.push({ sku: p._id, name: p.name, currentCost: p.cost, currentSupplier: suppliers.find(s => s._id === p.supplierId)?.name, ...q, skippedBlocked: quotes.filter(x => x.blocked).map(x => x.supplier) });
  }
  return out.sort((a, b) => Number(b.significant) - Number(a.significant) || b.savingPerUnit - a.savingPerUnit);
}

/** Live web search (SerpApi) + DB quotes for one product. Never fabricates: no key → says so. */
export async function searchSupplierPrices(query: string) {
  const products = await col.products.find().toArray();
  const product = matchProduct(query, products);
  const q = product?.name ?? query;
  const mem = await blockedSuppliers(true);
  const web = await serpShopping(q).catch((e: any) => ({ available: false, reason: `Live supplier search failed: ${e.message}`, offers: [], query: q }));
  const offers = web.offers.filter(o => !isBlocked(o.source, mem.blocked));
  const dbQuotes = product ? (await supplierOpportunities(mem.blocked)).find(o => o.sku === product._id) ?? null : null;
  return { product: product && { sku: product._id, name: product.name, cost: product.cost, price: product.price, currentSupplier: (await col.suppliers.findOne({ _id: product.supplierId }))?.name }, query: q, web: { ...web, offers, hiddenBlocked: web.offers.length - offers.length }, cheapestWeb: offers.slice().sort((a, b) => a.price - b.price)[0] ?? null, dbOpportunity: dbQuotes, threshold: supplierThreshold, memory: { source: mem.memorySource, recalled: mem.recalled } };
}

/**
 * Temporal activity: live prices for the at-risk products with the biggest reorder spend, cached in supplierPrices
 * (the dashboard reads that cache; it never calls SerpApi). No key → stored quotes stay, nothing written.
 * SUPPLIER_FAIL_FIRST_N simulates an outage to demo Temporal retries.
 */
export async function supplierPriceRefresh(attempt = 1) {
  const failN = Number(process.env.SUPPLIER_FAIL_FIRST_N ?? 0);
  if (attempt <= failN) throw new Error(`Simulated supplier API outage (attempt ${attempt}/${failN} configured to fail)`);
  if (!serpLive()) return { attempt, source: 'stored', reason: 'SERPAPI_API_KEY not set — no live search run; dashboard keeps showing stored supplier quotes.', refreshed: [] };
  const [inv, products, { blocked }] = await Promise.all([getInventory(), col.products.find().toArray(), blockedSuppliers()]);
  const cost = Object.fromEntries(products.map(p => [p._id, p.cost]));
  // At-risk first, then fill remaining quota with highest-price real-catalog SKUs so SerpApi covers the OFF catalogue
  const max = Number(process.env.SUPPLIER_REFRESH_MAX ?? 5);
  const atRisk = inv.lowStock.toSorted((a: any, b: any) => cost[b.sku] * b.reorderQty - cost[a.sku] * a.reorderQty);
  const rest = inv.items.filter((i: any) => !atRisk.some((a: any) => a.sku === i.sku)).toSorted((a: any, b: any) => (cost[b.sku] ?? 0) - (cost[a.sku] ?? 0));
  const targets = [...atRisk, ...rest].slice(0, max);
  const refreshed = await Promise.all(targets.map(async t => {
    try {
      const web = await serpShopping(t.name);
      const offers = web.offers.filter(o => !isBlocked(o.source, blocked)).sort((a, b) => a.price - b.price);
      const cheapest = offers[0] ?? null;
      await col.supplierPrices.replaceOne({ _id: t.sku }, { sku: t.sku, name: t.name, query: web.query, offers, cheapest, sourceDomain: cheapest?.sourceDomain ?? null, link: cheapest?.link ?? null, hiddenBlocked: web.offers.length - offers.length, rejected: web.rejected ?? 0, checkedAt: new Date() }, { upsert: true });
      return { product: t.name, offers: offers.length, cheapest };
    } catch (e: any) { return { product: t.name, error: e.message }; }
  }));
  if (refreshed.length && refreshed.every(r => 'error' in r)) throw new Error(`SerpApi failed for all ${refreshed.length} products: ${(refreshed[0] as any).error}`);
  return { attempt, source: 'serpapi', refreshed };
}

/** Latest cached live results (written by supplierPriceRefresh). */
export const livePrices = () => col.supplierPrices.find().sort({ checkedAt: -1 }).toArray();

// ---------- daily brief ----------

export async function briefFacts() {
  const [inv, pending, opp, sales] = await Promise.all([getInventory(), getPendingOrders(), supplierOpportunities(), salesSummary(7)]);
  return {
    date: today(),
    forecastMethod: inv.method,
    restockNow: inv.items.filter((i: any) => i.risk === 'high').map((i: any) => ({ name: i.name, available: i.available, demand7: i.demand7, daysOfCover: i.daysOfCover, leadTimeDays: i.leadTimeDays, reorderQty: i.reorderQty })),
    watch: inv.items.filter((i: any) => i.risk === 'medium').map((i: any) => ({ name: i.name, daysOfCover: i.daysOfCover, reorderQty: i.reorderQty })),
    pendingOrders: pending.orders.length,
    overdueOrders: pending.orders.filter(o => o.overdue).map(o => ({ id: o._id, customer: o.customerName, due: o.deliveryDate })),
    dueToday: pending.orders.filter(o => o.dueToday).map(o => ({ id: o._id, customer: o.customerName })),
    savings: opp.filter(o => o.significant).slice(0, 3).map(o => `${o.name}: switch to ${o.best.supplier} at ${inr(o.best.unitCost)} instead of ${inr(o.currentCost)} (${o.currentSupplier}), saving ${inr(o.savingPerUnit)} per unit (${o.savingPercent}%)`),
    topSeller7d: sales.top[0] ?? null,
  };
}

export function templateBrief(f: Awaited<ReturnType<typeof briefFacts>>) {
  const l = [`Business brief for ${shortDate(f.date)} (${methodLabel(f.forecastMethod)})`];
  if (f.overdueOrders.length) l.push(`• Overdue: ${f.overdueOrders.map(o => `${o.customer}'s order (was due ${o.due ? shortDate(o.due) : 'unknown'})`).join('; ')} — deliver or update the customer today.`);
  if (f.dueToday.length) l.push(`• Deliver today: ${f.dueToday.map(o => `${o.customer}'s order`).join('; ')}.`);
  if (f.restockNow.length) l.push(`• Restock now: ${f.restockNow.map(r => `${r.name} (order ${r.reorderQty})`).join(', ')} — these run out before a new delivery can arrive.`);
  if (f.watch.length) l.push(`• Watch: ${f.watch.map(w => w.name).join(', ')} — likely to run out within a week.`);
  l.push(`• ${f.pendingOrders} pending order${f.pendingOrders === 1 ? '' : 's'} in total.`);
  if (f.savings.length) l.push(`• Save money: ${f.savings.join('; ')}.`);
  if (f.topSeller7d) l.push(`• Top seller this week: ${f.topSeller7d.name} (${f.topSeller7d.qty} sold).`);
  return l.join('\n');
}

/** Orders or stock changed: today's stock plan and brief no longer match the data. */
export async function invalidateDay() {
  const date = today();
  await Promise.all([col.forecasts.deleteMany({ date }), col.briefs.updateMany({ date }, { $set: { stale: true } })]);
}

/**
 * Deterministic brief; Gemma adds a 1–2 sentence summary on top, kept only if it doesn't leak field names.
 * Cached per day until invalidateDay(); `fresh` rebuilds it (the morning workflow).
 */
export async function generateDailyBrief({ store = true, fresh = false } = {}) {
  if (!fresh) {
    const cached = await col.briefs.findOne({ date: today(), stale: { $ne: true } }, { sort: { createdAt: -1 } });
    if (cached) return { ...cached, cached: true };
  }
  const facts = await span('brief.facts', 'brief facts', {}, () => briefFacts());
  const brief = templateBrief(facts);
  let summary: string | null = null;
  try {
    const g = (await gemma([
      { role: 'system', content: 'You help a small online fitness-supplements shop owner in India. In one or two short sentences, say what matters most today, using only the brief below. Do not add any number, name or product that is not in the brief. Plain text.' },
      { role: 'user', content: brief },
    ], { maxTokens: BRIEF_MAX_TOKENS })).trim();
    // a summary cut off by the token cap doesn't end a sentence
    if (g && g.length <= 400 && /[.!?]["')]?$/.test(g) && looksClean(g)) summary = g; else log.warn({ len: g.length }, 'brief: Gemma summary rejected (empty, cut off, too long or leaked field names)');
  } catch (e: any) { log.warn({ err: e.message }, 'brief: Gemma unavailable, template only'); }
  const doc = { date: facts.date, text: summary ? `${summary}\n\n${brief}` : brief, summary, by: summary ? 'template+gemma' as const : 'template' as const, facts, createdAt: new Date() };
  if (store) await col.briefs.insertOne(doc);
  return doc;
}
