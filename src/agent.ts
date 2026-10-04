// Gemma = language. Tools = facts. Three routes, best first:
//   1. mastra-tools      Mastra Agent with native tool calling (only if the Ollama model reports 'tools')
//   2. gemma-json-router Gemma picks a tool by emitting JSON, validated by zod
//   3. keyword-router    deterministic regex routing when Gemma is down or emits junk
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { col, today } from './db.ts';
import { Extraction, buildDraft, looksClean, matchProduct, shortDate } from './logic.ts';
import { cleanCopy, displayName, inr, plural, units, whole } from './copy.ts';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
import * as Sentry from '@sentry/node';
import { MODEL, OLLAMA, annotate, gemma, gemmaCapabilities, llmDownNote, llmModel, llmProvider, log, parseJson, span, traced } from './integrations.ts';
import * as ops from './ops.ts';
import { searchCatalog, tigerDemand } from './tiger.ts';

const none = z.object({});

/** Atlas ops context (orders/stock/memory) — separate Sentry tool span. */
async function atlasOpsContext() {
  return span('gen_ai.execute_tool', 'execute_tool atlas_ops', { 'gen_ai.tool.name': 'atlas_ops' }, async set => {
    const [pending, memory, products] = await Promise.all([ops.getPendingOrders(), ops.getMemory(), col.products.countDocuments()]);
    const out = { store: 'atlas', pendingOrders: pending.orders.length, overdue: pending.orders.filter(o => o.overdue).length, preferences: memory.preferences.length, catalogSkus: products };
    set('gen_ai.tool.output', out);
    return out;
  });
}

/** Tiger analytics (7d/28d demand) — separate Sentry tool span. */
async function tigerAnalyticsContext() {
  return span('gen_ai.execute_tool', 'execute_tool tiger_analytics', { 'gen_ai.tool.name': 'tiger_analytics' }, async set => {
    const [dem, products] = await Promise.all([tigerDemand(), col.products.find({}, { projection: { name: 1 } }).toArray()]);
    const names = Object.fromEntries(products.map(p => [p._id, p.name]));
    const rows = Object.entries(dem).map(([sku, v]) => ({ sku, name: names[sku], ...v })).sort((a, b) => b.demand7 - a.demand7).slice(0, 8);
    const out = { store: 'tiger', skusWithDemand: Object.keys(dem).length, topDemand7: rows };
    set('gen_ai.tool.output', out);
    return out;
  });
}

/** Parallel Atlas + Tiger fetch for combined "how's the business" questions. */
export async function shopPulse() {
  const [atlas, tiger] = await Promise.all([atlasOpsContext(), tigerAnalyticsContext()]);
  return { atlas, tiger, fetched: 'parallel' };
}

const TOOLS = {
  get_inventory: { description: 'Current stock, reserved qty, 7-day demand forecast, stockout risk and reorder qty for every product. Use for "what should I restock".', args: none, run: () => ops.getInventory() },
  forecast_demand: { description: 'Same data focused on the demand forecast and stockout risk. Use for "which products will run out", "why is this product at risk" and "why do you recommend this".', args: none, run: () => ops.forecastDemand() },
  get_pending_orders: { description: 'Pending (not yet delivered) customer orders with due dates; flags overdue.', args: none, run: () => ops.getPendingOrders() },
  get_sales_summary: { description: 'Units sold per product over the last N days, best first.', args: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), run: (a: { days: number }) => ops.salesSummary(a.days) },
  search_catalog: { description: 'Hybrid search over the real product catalogue (Tiger pgvector + full-text). Use for "protein under 1500 no sugar", find products by constraint.', args: z.object({ query: z.string().trim().min(2).max(120) }), run: (a: { query: string }) => searchCatalog(a.query) },
  shop_pulse: { description: 'Combined Atlas ops (orders/stock/memory) + Tiger analytics (7d/28d demand) fetched in parallel. Use for "how is the business", "ops and demand together".', args: none, run: () => shopPulse() },
  search_supplier_prices: { description: 'Find cheaper suppliers for one product: live web prices (SerpApi) and stored supplier quotes. Respects blocked suppliers.', args: z.object({ product: z.string().trim().min(1).max(80) }), run: (a: { product: string }) => ops.searchSupplierPrices(a.product) },
  get_business_memory: { description: "The owner's saved business preferences/rules (e.g. blocked suppliers).", args: none, run: () => ops.getMemory() },
  save_business_memory: { description: 'Save a durable business preference the owner states, e.g. "I don\'t buy from Supplier X". Pass their exact words.', args: z.object({ text: z.string().trim().min(3).max(300) }), run: (a: { text: string }) => ops.saveMemory(a.text) },
  generate_daily_brief: { description: "Today's business brief: urgent orders, stockouts, savings, top seller. Use for 'what needs my attention' / 'what should I focus on today' / 'brief'.", args: none, run: () => ops.generateDailyBrief() },
} as const;
type ToolName = keyof typeof TOOLS;

async function runTool(name: ToolName, args: unknown) {
  const t = TOOLS[name];
  const a = t.args.parse(args ?? {});
  return span('gen_ai.execute_tool', `execute_tool ${name}`, { 'gen_ai.tool.name': name, 'gen_ai.tool.input': JSON.stringify(a) }, async set => {
    const out = await (t.run as (x: any) => Promise<any>)(a);
    set('gen_ai.tool.output', out);
    return out;
  });
}

// ---------- Mastra ----------

const mastraTools = Object.fromEntries(Object.entries(TOOLS).map(([id, t]) => [id, createTool({ id, description: t.description, inputSchema: t.args, execute: async (input: any) => runTool(id as ToolName, input?.context ?? input) })]));
export const mastraAgent = new Agent({
  id: 'nivara', name: 'Nivara',
  instructions: 'You are the operations copilot for a small online fitness-supplements shop. Always call a tool to get facts; never invent prices, stock, orders, customers or dates. Answer briefly using the tool output.',
  model: { providerId: 'ollama', modelId: MODEL, url: `${OLLAMA}/v1`, apiKey: process.env.OLLAMA_API_KEY ?? 'ollama' } as any,
  tools: mastraTools,
});

let caps: { at: number; v: string[] | null } = { at: 0, v: null };
export async function llmStatus() {
  if (Date.now() - caps.at > 30_000) caps = { at: Date.now(), v: await gemmaCapabilities() };
  const forced = process.env.AGENT_MODE;
  const nativeTools = llmProvider() === 'ollama' && (forced === 'mastra' || (forced !== 'router' && !!caps.v?.includes('tools')));
  return { reachable: !!caps.v, capabilities: caps.v, nativeTools };
}

// ---------- routing ----------

const Route = z.object({ tool: z.enum(Object.keys(TOOLS) as [ToolName, ...ToolName[]]), args: z.record(z.string(), z.any()).default({}) });

export function keywordRoute(q: string): { tool: ToolName; args: any } {
  const s = q.toLowerCase();
  if (/\b(remember|never buy|don'?t buy|do not buy|stop buying|avoid|note that)\b/.test(s)) return { tool: 'save_business_memory', args: { text: q } };
  if (/\b(memory|preferences?|what do you (remember|know))\b/.test(s)) return { tool: 'get_business_memory', args: {} };
  if (/\b(under|below|no sugar|sugar[- ]?free|find .*protein|catalog|catalogue|show me)\b/.test(s) || (/\bprotein\b/.test(s) && /\b(under|below|₹|rs)\b/.test(s)))
    return { tool: 'search_catalog', args: { query: q } };
  if (/\b(how('s| is) (the )?business|ops and demand|atlas and tiger|overall pulse|combined)\b/.test(s)) return { tool: 'shop_pulse', args: {} };
  if (/\b(supplier|cheaper|cheapest|wholesale)\b/.test(s) || (/\bprice\b/.test(s) && !/\bunder\b/.test(s))) return { tool: 'search_supplier_prices', args: { product: q } };
  if (/\b(pending|undelivered|orders?)\b/.test(s)) return { tool: 'get_pending_orders', args: {} };
  if (/\b(sell|sold|best ?seller|top|most)\b/.test(s)) return { tool: 'get_sales_summary', args: { days: /month/.test(s) ? 30 : 7 } };
  if (/\b(restock|reorder|low stock|buy)\b/.test(s)) return { tool: 'get_inventory', args: {} };
  if (/\b(run out|stock ?out|forecast|demand|why|explain|reason|anomal)/.test(s)) return { tool: 'forecast_demand', args: {} };
  return { tool: 'generate_daily_brief', args: {} };
}

type Msg = { role: 'user' | 'assistant'; content: string };

/** Longest product name/alias that appears verbatim in the text. */
function mentioned<T extends { name: string; aliases?: string[] }>(text: string, products: T[]) {
  const s = text.toLowerCase();
  let best: T | undefined, len = 0;
  for (const p of products) for (const n of [p.name, ...(p.aliases ?? [])]) if (n.length > len && s.includes(n.toLowerCase())) [best, len] = [p, n.length];
  return best;
}

/** Product the question is about: named in the message; "this/it" → last one named in the conversation, else the most at-risk. */
async function focusProduct(message: string, history: Msg[], fallbackToRisk: boolean) {
  const products = await col.products.find().toArray();
  const named = mentioned(message, products) ?? matchProduct(message, products);
  if (named) return named.name;
  if (!fallbackToRisk) return undefined;
  for (const m of [...history].reverse()) { const hit = mentioned(m.content, products); if (hit) return hit.name; }
  return (await ops.getInventory()).lowStock[0]?.name as string | undefined;
}

// ---------- final answers ----------
// Structured questions get deterministic templates built from tool output (numbers formatted, no field names).
// Gemma writes the answer only for open-ended questions, from these same readable facts, never from raw JSON.

const ANSWER_SYS = `You are Nivara, operations copilot for a small Indian online fitness-supplements shop.
Answer the owner's question using ONLY the FACTS (already checked against the database): one to three short plain sentences, then at most four short lines starting with "• " if a list helps.
Use whole numbers and ₹ amounts as written in the FACTS. No brackets, no markdown, no technical words.
Never add numbers, products, suppliers, customers or dates that are not in the FACTS. If the facts do not answer the question, say so plainly.`;

// Seller copy: a 1–3 sentence lead, then short "• " bullets. Whole units, ₹ with Indian grouping, no bracketed asides.
const left = (p: any) => p.available <= 0 ? 'nothing left to sell' : `${whole(p.available)} left to sell`;
const held = (p: any) => p.reserved ? `${p.stock} on the shelf, ${p.reserved} held for orders` : '';
const lasts = (p: any) => p.available <= 0 ? 'no stock left' : p.daysOfCover === null ? 'no recent sales' : `about ${plural(Math.max(1, whole(p.daysOfCover)), 'day')} of stock`;

function restockAnswer(out: any) {
  const high = out.items.filter((i: any) => i.risk === 'high'), med = out.items.filter((i: any) => i.risk === 'medium');
  if (!high.length && !med.length) return 'Nothing needs restocking this week. Every product has more than 7 days of stock.';
  const l: string[] = [];
  l.push(high.length
    ? `Restock ${high.length === 1 ? '1 product' : `${high.length} products`} now. ${high.length === 1 ? 'It runs' : 'They run'} out before a new delivery can arrive.${med.length ? ` ${plural(med.length, 'more product')} ${med.length === 1 ? 'runs' : 'run'} out this week.` : ''}`
    : `${plural(med.length, 'product')} ${med.length === 1 ? 'runs' : 'run'} out this week. Order soon.`);
  for (const p of [...high, ...med].slice(0, 8)) l.push(`• ${p.name}: order ${units(p.reorderQty)}. ${cap(left(p))}, ${lasts(p)}; delivery takes ${plural(p.leadTimeDays, 'day')}.`);
  if (high.length + med.length > 8) l.push(`• And ${plural(high.length + med.length - 8, 'more product')}. See Forecast for the full list.`);
  return l.join('\n');
}

function riskAnswer(out: any, focus?: string) {
  const p = focus && out.items.find((i: any) => i.name === focus);
  if (!p) {
    const risky = out.items.filter((i: any) => i.risk !== 'low');
    if (!risky.length) return 'No product is likely to run out this week.';
    return [`${plural(risky.length, 'product')} could run out soon. Ask "Why is ${risky[0].name} at risk?" for the reasons.`,
      ...risky.slice(0, 8).map((r: any) => `• ${r.name}: ${lasts(r)}, delivery takes ${plural(r.leadTimeDays, 'day')}. Order ${units(r.reorderQty)}.`)].join('\n');
  }
  const l = [p.risk === 'high' ? `${p.name} will run out before new stock can arrive.` : p.risk === 'medium' ? `${p.name} runs out within a week.` : `${p.name} is not at risk right now.`,
    `• Stock: ${left(p)}${held(p) ? `; ${held(p)}` : ''}.`,
    `• Expected to sell about ${units(p.demand7)} in the next 7 days${p.last7Sold != null ? `; ${whole(p.last7Sold)} sold last week` : ''}.`,
    p.risk === 'high' ? `• That is ${lasts(p)}, but a delivery takes ${plural(p.leadTimeDays, 'day')}.`
      : p.risk === 'medium' ? `• That is ${lasts(p)}. A delivery takes ${plural(p.leadTimeDays, 'day')}, so there is still time to reorder.`
        : `• That is ${lasts(p)}, longer than the ${plural(p.leadTimeDays, 'day')} a delivery takes.`];
  if (p.reorderQty) l.push(`• Order ${units(p.reorderQty)} now. That covers the delivery time, a week of sales and 3 spare days.`);
  return l.join('\n');
}

const when = (o: any) => o.overdue ? `overdue, was due ${shortDate(o.deliveryDate)}` : o.dueToday ? 'due today' : !o.deliveryDate ? 'no delivery date' : o.flag === 'due tomorrow' ? 'due tomorrow' : `due ${shortDate(o.deliveryDate)}`;
function ordersAnswer(out: any) {
  if (!out.orders.length) return 'You have no pending orders.';
  const overdue = out.orders.filter((o: any) => o.overdue).length;
  return [`You have ${plural(out.orders.length, 'pending order')}${overdue ? `, ${overdue} overdue` : ''}.`,
    ...out.orders.map((o: any) => `• ${o.customerName}: ${o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')} · ${inr(o.total)} · ${when(o)}`)].join('\n');
}

/** Sold counts are whole units; anything sold rounds up to at least 1. */
const sold = (q: number) => q > 0 ? Math.max(1, whole(q)) : 0;
function salesAnswer(out: any) {
  const top = out.top.filter((t: any) => t.name && sold(t.qty) > 0);
  if (!top.length) return `No sales recorded in the last ${out.days} days.`;
  const [b, ...rest] = top;
  return [`Your best seller over the last ${out.days} days was ${b.name}: ${units(sold(b.qty))} sold, ${inr(b.revenue)}.`,
    ...rest.slice(0, 4).map((t: any) => `• ${t.name}: ${units(sold(t.qty))}, ${inr(t.revenue)}`)].join('\n');
}

function catalogAnswer(out: any) {
  const f = out.filters ?? {};
  const limits = `${f.maxPrice ? ` under ${inr(f.maxPrice)}` : ''}${f.noSugar ? ' with little or no sugar' : ''}`;
  const hits = (out.hits ?? []).filter((h: any) => !f.maxPrice || h.price <= f.maxPrice).slice(0, 6);
  if (f.maxPrice) hits.sort((a: any, b: any) => a.price - b.price); // "under ₹X": cheapest first
  if (!hits.length) return `No products match "${f.q ?? out.query}"${limits}.`;
  return [`${hits.length === 1 ? '1 product matches' : `${Math.min(hits.length, 6)} products match`}${limits}.`,
    ...hits.slice(0, 6).map((h: any) => `• ${h.name} · ${inr(h.price)}${h.sugarPer100g != null ? ` · ${whole(h.sugarPer100g)} g sugar per 100 g` : ''}${whole(h.demand7) ? ` · about ${whole(h.demand7)} sold a week` : ''}`)].join('\n');
}

function supplierAnswer(out: any) {
  const l = [out.product ? `You pay ${inr(out.product.cost)} a unit for ${out.product.name}${out.product.currentSupplier ? ` at ${displayName(out.product.currentSupplier)}` : ''}.` : `I couldn't find "${out.query}" in your products.`];
  const o = out.dbOpportunity;
  if (o) l.push(`• Best stored quote: ${displayName(o.best.supplier)} at ${inr(o.best.unitCost)}, ${inr(o.savingPerUnit)} less a unit.${o.significant ? '' : ` That is under your ${inr(out.threshold.rupees)} and ${out.threshold.percent}% rule, so it is not flagged.`}`);
  else if (out.product) l.push('• No cheaper quote from the suppliers you use.');
  if (o?.skippedBlocked.length) l.push(`• Left out because you blocked ${o.skippedBlocked.length > 1 ? 'them' : 'it'}: ${o.skippedBlocked.map(displayName).join(', ')}.`);
  const c = out.cheapestWeb;
  l.push(!out.web.available ? '• Online prices are not available right now, so this uses your stored quotes.' : c ? `• Cheapest online: ${inr(c.price)} at ${c.source}. Check the pack size before comparing.` : '• No usable online prices found.');
  if (out.web.hiddenBlocked) l.push(`• Hid ${plural(out.web.hiddenBlocked, 'online listing')} from blocked suppliers.`);
  return l.join('\n');
}

export function templateAnswer(tool: ToolName, out: any, focus?: string): string {
  switch (tool) {
    case 'get_inventory': return restockAnswer(out);
    case 'forecast_demand': return riskAnswer(out, focus);
    case 'get_pending_orders': return ordersAnswer(out);
    case 'get_sales_summary': return salesAnswer(out);
    case 'search_catalog': return catalogAnswer(out);
    case 'shop_pulse': {
      const a = out.atlas ?? {}, t = out.tiger ?? {};
      const top = (t.topDemand7 ?? []).filter((x: any) => x.name && sold(x.demand7)).slice(0, 3);
      return [`You have ${plural(a.pendingOrders ?? 0, 'pending order')}${a.overdue ? `, ${a.overdue} overdue` : ''}.`,
        `• Products: ${a.catalogSkus ?? 0}`,
        `• Saved rules: ${a.preferences ?? 0}`,
        ...(top.length ? [`• Selling fastest: ${top.map((x: any) => `${x.name}, about ${sold(x.demand7)} a week`).join('; ')}`] : [])].join('\n');
    }
    case 'search_supplier_prices': return supplierAnswer(out);
    case 'save_business_memory': {
      const p = out.saved;
      return `Got it. I'll remember: "${p.text}".${p.kind === 'block_supplier' ? ` I won't suggest ${displayName(p.supplier)} as a supplier.` : ''}${out.note ? ' ' + out.note : ''}`;
    }
    case 'get_business_memory':
      return out.preferences.length ? ["Here's what I remember:", ...out.preferences.map((p: any) => `• ${p.text}`)].join('\n') : 'Nothing saved yet. Tell me a rule, like "I never buy from Supplier C".';
    case 'generate_daily_brief': return cleanCopy(out.text);
  }
}

/** Standard operational questions (the keyword router recognises them) get templates; anything else is open-ended. */
export const isStructured = (q: string) => keywordRoute(q).tool !== 'generate_daily_brief' || /\b(focus|today|brief|attention|priorit\w*|summary)\b/i.test(q);

/** "Give me today's brief": the keyword router agrees and names it, so a Gemma routing round trip adds only latency. */
export const asksForBrief = (q: string) => /\bbrief(ing)?\b/i.test(q) && keywordRoute(q).tool === 'generate_daily_brief';

export async function ask(message: string, history: Msg[] = [], conversationId?: string) {
  return traced('assistant', message, async () => {
    if (conversationId) Sentry.setConversationId(conversationId);
    const status = await llmStatus();
    let route: 'mastra-tools' | 'gemma-json-router' | 'keyword-router' = 'keyword-router';
    let pick: { tool: ToolName; args: any } | undefined, answer: string | undefined, data: any;
    const notes: string[] = [];
    if (asksForBrief(message)) { pick = { tool: 'generate_daily_brief', args: {} }; notes.push('Brief asked for by name; no routing call needed.'); }

    if (!pick && status.reachable && status.nativeTools) {
      try {
        const r: any = await span('gen_ai.chat', 'mastra agent.generate', { 'gen_ai.request.model': MODEL }, () => mastraAgent.generate([...history.slice(-6), { role: 'user', content: message }] as any, { maxSteps: 3 } as any));
        const tr = (r.toolResults ?? r.steps?.flatMap((s: any) => s.toolResults ?? []) ?? [])[0];
        if (tr && r.text) { route = 'mastra-tools'; pick = { tool: (tr.toolName ?? tr.payload?.toolName) as ToolName, args: tr.args ?? tr.payload?.args }; data = tr.result ?? tr.payload?.result; answer = r.text; }
        else notes.push('Mastra agent returned no tool call; fell back to JSON router.');
      } catch (e: any) { notes.push(`Mastra tool calling failed (${e.message.slice(0, 120)}); fell back to JSON router.`); }
    } else if (!pick && status.reachable) notes.push(llmProvider() === 'gemini'
      ? `${llmModel()} via Gemini API; Gemma selects tools via validated JSON instead.`
      : `${llmModel()} does not advertise native tool calling in Ollama; Gemma selects tools via validated JSON instead.`);

    if (!pick && status.reachable) {
      try {
        const raw = await gemma([
          { role: 'system', content: `Pick exactly one tool for the shop owner's latest message. Reply ONLY with JSON {"tool": "<name>", "args": {...}}.\nTools:\n${Object.entries(TOOLS).map(([k, t]) => `- ${k}: ${t.description}${k === 'search_supplier_prices' ? ' args: {"product": "<product name>"}' : k === 'search_catalog' ? ' args: {"query": "<constraints>"}' : k === 'save_business_memory' ? ' args: {"text": "<owner words>"}' : k === 'get_sales_summary' ? ' args: {"days": 7}' : ' args: {}'}`).join('\n')}` },
          ...history.slice(-4), { role: 'user', content: message },
        ], { json: true, timeoutMs: 60_000 });
        pick = Route.parse(parseJson(raw));
        TOOLS[pick.tool].args.parse(pick.args);
        route = 'gemma-json-router';
      } catch (e: any) { pick = undefined; notes.push(`Gemma routing output rejected (${e.message.slice(0, 100)}); used keyword router.`); }
    }
    if (!pick) { pick = keywordRoute(message); if (!status.reachable) notes.push(llmDownNote()); }
    if (pick.tool === 'search_supplier_prices') {
      const products = await col.products.find().toArray(), arg = String(pick.args?.product ?? message);
      pick.args = { product: matchProduct(arg, products) ? arg : await focusProduct(arg, history, true) ?? arg };
    }
    // the owner's own words keep price caps and brand names intact; the model's rewrite can drop or add terms
    if (pick.tool === 'search_catalog' && keywordRoute(message).tool === 'search_catalog') pick.args = { query: message };
    const focus = pick.tool === 'forecast_demand' ? await focusProduct(message, history, /\b(this|that|it)\b/i.test(message)) : undefined;

    data ??= await runTool(pick.tool, pick.args);
    let answerMode: 'template' | 'template+gemma' | 'gemma' = answer ? 'gemma' : pick.tool === 'generate_daily_brief' && data.by === 'template+gemma' ? 'template+gemma' : 'template';
    if (!answer) {
      answer = templateAnswer(pick.tool, data, focus);
      if (!isStructured(message) && status.reachable) {
        try {
          const g = (await gemma([{ role: 'system', content: ANSWER_SYS }, ...history.slice(-4), { role: 'user', content: `QUESTION: ${message}\n\nFACTS:\n${answer}` }])).trim();
          if (g && looksClean(g)) { answer = g; answerMode = 'gemma'; } else notes.push('Gemma answer leaked field names or was empty; showing the template answer.');
        } catch (e: any) { notes.push(`Gemma answer failed (${e.message.slice(0, 100)}); template answer.`); }
      }
    }
    annotate({ 'nivara.route': route, 'gen_ai.tool.name': pick.tool, 'nivara.answer_mode': answerMode, 'nivara.message_chars': message.length });
    log.info({ route, tool: pick.tool, answerMode }, 'assistant answered');
    return { answer, answerMode, route, tool: pick.tool, args: pick.args, focus, data, model: status.reachable ? llmModel() : null, notes };
  });
}

// ---------- order extraction ----------

export async function extractOrder(text: string) {
  return traced('order_extraction', text, async () => {
    const [products, customers] = await Promise.all([col.products.find().toArray(), col.customers.find().toArray()]);
    const msgs = [
      { role: 'system', content: `Extract a customer order from a shop owner's note. Reply ONLY with JSON:
{"customer": string, "items": [{"product": string, "quantity": integer}], "delivery_text": string|null}
- product: the closest name from this catalogue if obvious, else the customer's words: ${products.map(p => p.name).join('; ')}
- quantity: integer (convert words like "one" to 1)
- delivery_text: the delivery phrase copied verbatim (e.g. "tomorrow", "friday", "12 oct"), or null. Do NOT convert it to a date.` },
      { role: 'user', content: text },
    ];
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await gemma(attempt === 1 ? msgs : [...msgs, { role: 'user', content: `Your previous JSON was invalid (${lastErr}). Return valid JSON only.` }], { json: true, timeoutMs: 60_000 });
      const parsed = (() => { try { return Extraction.safeParse(parseJson(raw)); } catch (e: any) { return { success: false as const, error: { message: e.message } }; } })();
      if (parsed.success) return { extraction: parsed.data, draft: buildDraft(parsed.data, products, customers, today()), attempts: attempt, model: llmModel() };
      lastErr = parsed.error.message.slice(0, 200);
    }
    throw Object.assign(new Error(`Gemma did not return a valid order after 2 attempts: ${lastErr}`), { status: 422 });
  });
}
