// Gemma = language. Tools = facts. Three routes, best first:
//   1. mastra-tools      Mastra Agent with native tool calling (only if the Ollama model reports 'tools')
//   2. gemma-json-router Gemma picks a tool by emitting JSON, validated by zod
//   3. keyword-router    deterministic regex routing when Gemma is down or emits junk
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { col, today } from './db.ts';
import { Extraction, buildDraft, inr, looksClean, matchProduct, methodLabel, shortDate, units } from './logic.ts';
import { MODEL, OLLAMA, annotate, gemma, gemmaCapabilities, log, parseJson, span, traced } from './integrations.ts';
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
  return { reachable: !!caps.v, capabilities: caps.v, nativeTools: forced === 'mastra' || (forced !== 'router' && !!caps.v?.includes('tools')) };
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
