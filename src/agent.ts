// Gemma = language. Tools = facts. Three routes, best first:
//   1. mastra-tools      Mastra Agent with native tool calling (only if the Ollama model reports 'tools')
//   2. gemma-json-router Gemma picks a tool by emitting JSON, validated by zod
//   3. keyword-router    deterministic regex routing when Gemma is down or emits junk
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { col, today } from './db.ts';
import { Extraction, buildDraft, inr, looksClean, matchProduct, methodLabel, shortDate, units } from './logic.ts';
import { MODEL, OLLAMA, annotate, gemma, gemmaCapabilities, llmDownNote, llmModel, llmProvider, log, parseJson, span, traced } from './integrations.ts';
import * as ops from './ops.ts';

const none = z.object({});
const TOOLS = {
  get_inventory: { description: 'Current stock, reserved qty, 7-day demand forecast, stockout risk and reorder qty for every product. Use for "what should I restock".', args: none, run: () => ops.getInventory() },
  forecast_demand: { description: 'Same data focused on the demand forecast and stockout risk. Use for "which products will run out", "why is this product at risk" and "why do you recommend this".', args: none, run: () => ops.forecastDemand() },
  get_pending_orders: { description: 'Pending (not yet delivered) customer orders with due dates; flags overdue.', args: none, run: () => ops.getPendingOrders() },
  get_sales_summary: { description: 'Units sold per product over the last N days, best first.', args: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), run: (a: { days: number }) => ops.salesSummary(a.days) },
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
  if (/\b(supplier|cheaper|cheapest|price|wholesale)\b/.test(s)) return { tool: 'search_supplier_prices', args: { product: q } };
  if (/\b(pending|undelivered|orders?)\b/.test(s)) return { tool: 'get_pending_orders', args: {} };
  if (/\b(sell|sold|best ?seller|top|most)\b/.test(s)) return { tool: 'get_sales_summary', args: { days: /month/.test(s) ? 30 : 7 } };
  if (/\b(restock|reorder|low stock|buy)\b/.test(s)) return { tool: 'get_inventory', args: {} };
  if (/\b(run out|stock ?out|forecast|demand|why|explain|reason)\b/.test(s)) return { tool: 'forecast_demand', args: {} };
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
Answer the owner's question in 2-5 short plain-text lines using ONLY the FACTS (already checked against the database).
Never add numbers, products, suppliers, customers or dates that are not in the FACTS. If the facts do not answer the question, say so plainly.`;

const one = (n: number) => Math.round(n * 10) / 10;
const stockText = (p: any) => p.available <= 0 ? `nothing available to sell (${p.stock} in stock, ${p.reserved} reserved for pending orders)` : `${units(p.available)} available to sell${p.reserved ? ` (${p.stock} in stock, ${p.reserved} reserved for pending orders)` : ''}`;
const coverText = (p: any) => p.available <= 0 ? 'no stock left' : p.daysOfCover === null ? 'no recent sales' : `about ${one(p.daysOfCover)} days of stock`;
const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function restockAnswer(out: any) {
  const high = out.items.filter((i: any) => i.risk === 'high'), med = out.items.filter((i: any) => i.risk === 'medium');
  if (!high.length && !med.length) return 'Nothing needs restocking this week: every product has more than 7 days of stock.';
  const l: string[] = [];
  if (high.length) l.push(`Restock ${high.length === 1 ? 'this product' : `these ${high.length} products`} now. Each will run out before a new delivery can arrive:`,
    ...high.map((p: any) => `• ${p.name}: order ${units(p.reorderQty)}. ${stockText(p)}; about ${units(p.demand7)} expected to sell in the next 7 days, so ${coverText(p)} vs a ${p.leadTimeDays}-day delivery time.`));
  if (med.length) l.push(`${high.length ? '\n' : ''}Order soon (likely to run out within a week):`, ...med.map((p: any) => `• ${p.name}: order ${units(p.reorderQty)}. ${stockText(p)}, ${coverText(p)}.`));
  l.push(`\nBased on the ${methodLabel(out.method)}.`);
  return l.join('\n');
}

function riskAnswer(out: any, focus?: string) {
  const p = focus && out.items.find((i: any) => i.name === focus);
  if (!p) {
    const risky = out.items.filter((i: any) => i.risk !== 'low');
    if (!risky.length) return 'No product is likely to run out this week.';
    return [`${s(risky.length, 'product')} could run out soon:`, ...risky.map((r: any) => `• ${r.name} (${r.risk} risk): ${coverText(r)} vs a ${r.leadTimeDays}-day delivery time. Order ${units(r.reorderQty)}.`),
      `\nAsk "Why is ${risky[0].name} at risk?" for the full reasoning. (${methodLabel(out.method)})`].join('\n');
  }
  const l = [`${p.name} is ${p.risk === 'low' ? 'not at risk right now' : `at ${p.risk} risk of running out`}.`,
    `• Stock: ${stockText(p)}.`,
    `• Expected demand: about ${units(p.demand7)} over the next 7 days (roughly ${one(p.demand7 / 7)} a day, ${methodLabel(out.method)})${p.last7Sold != null ? `; ${p.last7Sold} sold in the last 7 days` : ''}.`,
    p.risk === 'high' ? `• That is ${coverText(p)}, but a new delivery takes ${p.leadTimeDays} days, so you would run out before it arrives.`
      : p.risk === 'medium' ? `• That is ${coverText(p)}. A new delivery (${p.leadTimeDays} days) can still arrive in time, but stock runs out within a week.`
        : `• That is ${coverText(p)}: more than a week, and longer than the ${p.leadTimeDays}-day delivery time.`];
  if (p.reorderQty) l.push(`• Recommendation: order ${units(p.reorderQty)} now. That covers the ${p.leadTimeDays}-day delivery time plus 7 days of sales and 3 safety days.`);
  return l.join('\n');
}

const when = (o: any) => o.overdue ? `overdue (was due ${shortDate(o.deliveryDate)})` : o.dueToday ? 'due today' : !o.deliveryDate ? 'no delivery date set' : o.flag === 'due tomorrow' ? 'due tomorrow' : `due ${shortDate(o.deliveryDate)}`;
function ordersAnswer(out: any) {
  if (!out.orders.length) return 'You have no pending orders.';
  const overdue = out.orders.filter((o: any) => o.overdue).length;
  return [`You have ${s(out.orders.length, 'pending order')}${overdue ? ` (${overdue} overdue)` : ''}:`,
    ...out.orders.map((o: any) => `• ${o.customerName}: ${o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')} · ${inr(o.total)} · ${when(o)}`)].join('\n');
}

function salesAnswer(out: any) {
  if (!out.top.length) return `No sales recorded in the last ${out.days} days.`;
  const [b, ...rest] = out.top;
  return [`Your best-selling product over the last ${out.days} days was ${b.name}, with ${units(b.qty)} sold (${inr(b.revenue)}).`,
    ...(rest.length ? ['Next best:', ...rest.slice(0, 4).map((t: any) => `• ${t.name}: ${units(t.qty)} (${inr(t.revenue)})`)] : [])].join('\n');
}

function supplierAnswer(out: any) {
  const l = [out.product ? `${out.product.name}: you currently pay ${inr(out.product.cost)} per unit${out.product.currentSupplier ? ` (${out.product.currentSupplier})` : ''}.` : `I couldn't match "${out.query}" to a product in your catalogue.`];
  const o = out.dbOpportunity;
  if (o) l.push(`• Stored quote: ${o.best.supplier} at ${inr(o.best.unitCost)}, saving ${inr(o.savingPerUnit)} per unit (${o.savingPercent}%)${o.significant ? '.' : `. That is below your ${inr(out.threshold.rupees)} and ${out.threshold.percent}% threshold, so it is not flagged.`}`);
  else if (out.product) l.push('• No cheaper stored quote from a supplier you buy from.');
  if (o?.skippedBlocked.length) l.push(`• Skipped blocked supplier${o.skippedBlocked.length > 1 ? 's' : ''}: ${o.skippedBlocked.join(', ')}.`);
  const c = out.cheapestWeb;
  l.push(!out.web.available ? `• ${out.web.reason}` : c ? `• Cheapest live listing: ${inr(c.price)} from ${c.source} (${c.sourceDomain}). Retail listing, so check the pack size before comparing.` : '• Live search found no usable listings.');
  if (out.web.hiddenBlocked) l.push(`• Hid ${s(out.web.hiddenBlocked, 'live listing')} from blocked suppliers.`);
  if (out.memory?.recalled?.length) l.push(`• From your saved memory: ${out.memory.recalled.slice(0, 2).join('; ')}`);
  return l.join('\n');
}

export function templateAnswer(tool: ToolName, out: any, focus?: string): string {
  switch (tool) {
    case 'get_inventory': return restockAnswer(out);
    case 'forecast_demand': return riskAnswer(out, focus);
    case 'get_pending_orders': return ordersAnswer(out);
    case 'get_sales_summary': return salesAnswer(out);
    case 'search_supplier_prices': return supplierAnswer(out);
    case 'save_business_memory': {
      const p = out.saved;
      return `Got it. I'll remember: "${p.text}".${p.kind === 'block_supplier' ? ` I won't suggest ${p.supplier} as a supplier.` : ''}${out.note ? ' ' + out.note : ''}\nSaved in your database${p.mirror === 'backboard' ? ' and in Backboard memory' : out.backboardError ? ' only (Backboard was unavailable)' : ''}.`;
    }
    case 'get_business_memory':
      return (out.preferences.length ? ["Here's what I remember:", ...out.preferences.map((p: any) => `• ${p.text}`)].join('\n') : 'I have no saved preferences yet.') + (out.backboard?.live ? `\nBackboard memory holds ${s(out.backboard.memories.length, 'item')}.` : '');
    case 'generate_daily_brief': return out.text;
  }
}

/** Standard operational questions (the keyword router recognises them) get templates; anything else is open-ended. */
export const isStructured = (q: string) => keywordRoute(q).tool !== 'generate_daily_brief' || /\b(focus|today|brief|attention|priorit\w*|summary)\b/i.test(q);

export async function ask(message: string, history: Msg[] = []) {
  return traced('assistant', message, async () => {
    const status = await llmStatus();
    let route: 'mastra-tools' | 'gemma-json-router' | 'keyword-router' = 'keyword-router';
    let pick: { tool: ToolName; args: any } | undefined, answer: string | undefined, data: any;
    const notes: string[] = [];

    if (status.reachable && status.nativeTools) {
      try {
        const r: any = await span('gen_ai.chat', 'mastra agent.generate', { 'gen_ai.request.model': MODEL }, () => mastraAgent.generate([...history.slice(-6), { role: 'user', content: message }] as any, { maxSteps: 3 } as any));
        const tr = (r.toolResults ?? r.steps?.flatMap((s: any) => s.toolResults ?? []) ?? [])[0];
        if (tr && r.text) { route = 'mastra-tools'; pick = { tool: (tr.toolName ?? tr.payload?.toolName) as ToolName, args: tr.args ?? tr.payload?.args }; data = tr.result ?? tr.payload?.result; answer = r.text; }
        else notes.push('Mastra agent returned no tool call; fell back to JSON router.');
      } catch (e: any) { notes.push(`Mastra tool calling failed (${e.message.slice(0, 120)}); fell back to JSON router.`); }
    } else if (status.reachable) notes.push(llmProvider() === 'gemini'
      ? `${llmModel()} via Gemini API; Gemma selects tools via validated JSON instead.`
      : `${llmModel()} does not advertise native tool calling in Ollama; Gemma selects tools via validated JSON instead.`);

    if (!pick && status.reachable) {
      try {
        const raw = await gemma([
          { role: 'system', content: `Pick exactly one tool for the shop owner's latest message. Reply ONLY with JSON {"tool": "<name>", "args": {...}}.\nTools:\n${Object.entries(TOOLS).map(([k, t]) => `- ${k}: ${t.description}${k === 'search_supplier_prices' ? ' args: {"product": "<product name>"}' : k === 'save_business_memory' ? ' args: {"text": "<owner words>"}' : k === 'get_sales_summary' ? ' args: {"days": 7}' : ' args: {}'}`).join('\n')}` },
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
