// Public response shapes. Routes return these, never raw tool output: no model/tool/route names, trace ids,
// method labels, hosts, keys, licence/provenance fields or raw upstream errors. Pure functions, unit-tested.
import { cleanCopy, displayName, splitAnswer, whole } from './copy.ts';

// ---------- assistant ----------
export function publicAnswer(r: { answer?: string }) {
  const answer = cleanCopy(r.answer ?? '') || "I couldn't find an answer to that. Try asking another way.";
  return { answer, ...splitAnswer(answer) };
}

// ---------- products / orders / suppliers ----------
export const publicProduct = (p: any) => ({ _id: p._id, name: p.name, category: p.category, price: p.price, cost: p.cost, stock: p.stock, supplierId: p.supplierId, leadTimeDays: p.leadTimeDays });

export const publicOrder = (o: any) => ({
  _id: o._id, customerName: o.customerName, items: (o.items ?? []).map((i: any) => ({ sku: i.sku, name: i.name, quantity: i.quantity, price: i.price })),
  total: o.total, status: o.status, deliveryDate: o.deliveryDate ?? null, createdAt: o.createdAt,
  ...(o.flag !== undefined && { flag: o.flag, overdue: !!o.overdue, dueToday: !!o.dueToday }), ...(o.demo && { demo: true }),
});

export const publicOpportunity = (o: any) => ({
  sku: o.sku, name: o.name, currentCost: o.currentCost, currentSupplier: displayName(o.currentSupplier),
  best: { supplier: displayName(o.best?.supplier), unitCost: o.best?.unitCost }, savingPerUnit: whole(o.savingPerUnit), savingPercent: whole(o.savingPercent),
  significant: !!o.significant, skippedBlocked: [...new Set<string>((o.skippedBlocked ?? []).map(displayName))],
});

export const publicStockItem = (i: any) => ({
  sku: i.sku, name: i.name, stock: i.stock, reserved: i.reserved, available: i.available, leadTimeDays: i.leadTimeDays,
  last7Sold: whole(i.last7Sold), demand7: whole(i.demand7), daysOfCover: i.daysOfCover == null ? null : whole(i.daysOfCover), risk: i.risk, reorderQty: whole(i.reorderQty),
});

export const publicForecast = (f: any) => ({ date: f.date, updatedAt: f.createdAt, historyDays: f.historyDays, items: (f.items ?? []).map(publicStockItem) });

export const publicBrief = (b: any) => b && { date: b.date, createdAt: b.createdAt, text: cleanCopy(b.text) };

export const publicLivePrice = (p: any) => ({ sku: p.sku, name: p.name, cheapest: p.cheapest ? { price: p.cheapest.price, source: p.cheapest.source } : null, link: p.link ?? null });

export function publicSearch(r: any) {
  return {
    product: r.product && { name: r.product.name, cost: r.product.cost, price: r.product.price, currentSupplier: displayName(r.product.currentSupplier) },
    web: { available: !!r.web?.available, message: r.web?.available ? undefined : cleanCopy(r.web?.reason ?? '') || 'Online prices are not available right now.',
      offers: (r.web?.offers ?? []).map((o: any) => ({ title: o.title, source: o.source, price: o.price, link: o.link })), hiddenBlocked: r.web?.hiddenBlocked ?? 0 },
    dbOpportunity: r.dbOpportunity ? publicOpportunity(r.dbOpportunity) : null,
    threshold: r.threshold,
  };
}

export const publicCatalog = (r: any) => ({ query: r.filters?.q ?? r.query, maxPrice: r.filters?.maxPrice ?? null, hits: (r.hits ?? []).map((h: any) => ({ sku: h.sku, name: h.name, category: h.category, price: h.price, sugarPer100g: h.sugarPer100g ?? null })) });

export const publicMemory = (m: any) => ({ preferences: (m.preferences ?? []).map((p: any) => ({ text: p.text, kind: p.kind, supplier: p.supplier ? displayName(p.supplier) : undefined, createdAt: p.createdAt })) });

export function publicDraft(x: any) {
  const d = x.draft;
  return { draft: { customer: d.customer, items: d.items, deliveryText: d.deliveryText, deliveryDate: d.deliveryDate, total: d.total, problems: d.problems.map(cleanCopy) } };
}

// ---------- workflows ----------
export const WORKFLOW_LABEL: Record<string, string> = { dailyBriefWorkflow: 'Morning brief', lowStockWorkflow: 'Low-stock check', forecastWorkflow: 'Forecast', supplierRefreshWorkflow: 'Online prices' };

export function publicRun(name: string, r: any) {
  const res = r.result ?? null, steps: Record<string, any> = {};
  if (res?.forecast) steps.forecast = { runsOutFirst: res.forecast.highRisk ?? 0 };
  if (res?.lowStockCheck) steps.lowStockCheck = { items: (res.lowStockCheck.lowStock ?? []).map((i: any) => ({ name: i.name, risk: i.risk, reorderQty: whole(i.reorderQty) })) };
  if (res?.supplierRefresh) {
    const s = res.supplierRefresh;
    steps.supplierRefresh = s.error ? { status: 'skipped' } : s.source === 'stored' ? { status: 'off' }
      : { status: 'updated', items: (s.refreshed ?? []).map((p: any) => ({ product: p.product, listings: p.offers ?? 0, cheapest: p.cheapest ? { price: p.cheapest.price, source: p.cheapest.source } : null, missed: !!p.error })) };
  }
  if (res?.dailyBrief) steps.dailyBrief = { text: cleanCopy(res.dailyBrief.text) };
  return { name, label: WORKFLOW_LABEL[name] ?? 'Job', done: !!res, steps, ...(res ? {} : { message: 'Still running. Check back in a minute.' }) };
}

const RUN_STATUS: Record<string, string> = { COMPLETED: 'done', RUNNING: 'running', FAILED: 'failed', TIMED_OUT: 'failed', TERMINATED: 'stopped', CANCELLED: 'stopped', CONTINUED_AS_NEW: 'done' };
export const publicWorkflows = (w: { runs: any[]; schedule: any; briefs: any[] }) => ({
  schedule: w.schedule?.next ? { next: w.schedule.next } : null,
  runs: w.runs.map(r => ({ label: WORKFLOW_LABEL[r.type] ?? 'Job', status: RUN_STATUS[r.status] ?? 'running', start: r.start })),
  briefs: w.briefs.map(publicBrief),
});

// ---------- activity (behind the scenes) ----------
const KIND: Record<string, string> = {
  assistant: 'Answered a question', order_extraction: 'Read an order message',
  'workflow.dailyBriefWorkflow': 'Morning brief', 'workflow.lowStockWorkflow': 'Low-stock check', 'workflow.forecastWorkflow': 'Forecast', 'workflow.supplierRefreshWorkflow': 'Online prices',
  'activity.forecast': 'Forecast step', 'activity.lowStockCheck': 'Low-stock step', 'activity.supplierRefresh': 'Online prices step', 'activity.dailyBrief': 'Brief step',
};
const TOOL: Record<string, string> = {
  get_inventory: 'Looked up stock', forecast_demand: 'Worked out demand', get_pending_orders: 'Looked up orders', get_sales_summary: 'Looked up sales',
  search_catalog: 'Searched products', searchCatalog: 'Searched products', shop_pulse: 'Gathered a shop overview', atlas_ops: 'Read orders and stock', tiger_analytics: 'Read sales trends',
  search_supplier_prices: 'Checked supplier prices', get_business_memory: 'Read saved rules', save_business_memory: 'Saved a rule', generate_daily_brief: 'Made the brief',
};
function stepLabel(s: any): string | null {
  if (s.op === 'gen_ai.invoke_agent') return null;
  if (s.op === 'gen_ai.chat') return 'Gemma wrote or chose';
  if (s.op === 'gen_ai.execute_tool') return TOOL[String(s.name).replace(/^execute_tool /, '')] ?? 'Looked something up';
  if (s.op === 'tool.serpapi') return 'Checked online prices';
  if (s.op === 'memory.backboard') return 'Used Backboard memory';
  if (s.op === 'brief.facts') return 'Gathered the brief facts';
  return 'Worked on it';
}
export function publicActivity(t: any) {
  const steps = (t.spans ?? []).flatMap((s: any) => { const label = stepLabel(s); return label ? [{ label, ms: s.ms ?? 0, ok: !s.error }] : []; });
  return { at: t.at, what: KIND[t.kind] ?? (String(t.kind).startsWith('activity.') ? 'Job step' : 'Background job'), question: t.kind === 'assistant' || t.kind === 'order_extraction' ? String(t.input ?? '').slice(0, 120) : '', ms: t.ms ?? 0, ok: !t.error, steps };
}

// ---------- health (behind the scenes) ----------
type HealthIn = { date: string; mongo: boolean; gemma: boolean; mastra: boolean; forecast: any; tiger: boolean; serpapi: boolean; backboard: boolean; elevenlabs: boolean; temporal: boolean; sentry: boolean };
/** Partner statuses worded for people: live or standby, what it does, and what happens when it rests. No hosts, keys or errors. */
export function publicHealth(h: HealthIn) {
  const f = h.forecast, tab = f?.method === 'tabpfn';
  const p = (name: string, live: boolean, on: string, off: string) => ({ name, status: live ? 'live' : 'standby', note: live ? on : off });
  return {
    ok: h.mongo, date: h.date,
    integrations: {
      mongodb: p('MongoDB Atlas', h.mongo, 'Stores products, orders, customers and saved rules.', 'Not reachable right now. Pages will load again when it is back.'),
      gemma: p('Gemma', h.gemma, 'Reads order messages, picks the right lookup for each question and writes the brief summary.', 'Resting. Answers use ready-made wording built from your data.'),
      mastra: p('Mastra', h.mastra, "Runs the assistant's tools.", 'On standby. Gemma picks the tools directly, with the same checks.'),
      tabpfn: p('TabPFN', tab, f?.precomputed ? `Forecasts 7-day demand for ${f.precomputed.skus} products, worked out ahead and stored.` : 'Forecasts 7-day demand, worked out on this server.', 'On standby. An average of recent sales keeps the forecast going.'),
      tiger: p('Tiger Data', h.tiger, 'Keeps sales history and powers product search.', 'On standby. Product search uses simple matching.'),
      serpapi: p('SerpApi', h.serpapi, 'Checks online shop prices each morning.', 'Not set up. Stored supplier quotes are used.'),
      backboard: p('Backboard', h.backboard, 'Remembers your rules, like suppliers you avoid.', 'Not set up. Rules are kept in the main database.'),
      elevenlabs: p('ElevenLabs', h.elevenlabs, 'Listens to spoken questions and reads answers aloud.', "On standby. The browser's own voice is used."),
      temporal: p('Temporal', h.temporal, 'Runs the morning brief and other jobs on a schedule, with retries.', 'On standby. Jobs run inside the app, with retries.'),
      sentry: p('Sentry', h.sentry, 'Watches for errors and slow answers.', 'Not set up. Activity is kept here only.'),
    },
  };
}
