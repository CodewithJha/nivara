// Pure, deterministic business rules. No I/O. Everything numeric the UI shows comes from here.
import { z } from 'zod';

// ---------- forecast fallback + stock rules ----------

/** Mean of the last `window` days × 7. Deterministic fallback when TabPFN is unavailable. */
export function movingAverage7(daily: number[], window = 14): number {
  const tail = daily.slice(-window);
  if (!tail.length) return 0;
  return Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 7 * 10) / 10;
}

export type Risk = 'high' | 'medium' | 'low';

/**
 * high   = runs out before a reorder placed today could arrive (cover < lead time)
 * medium = runs out within 7 days
 * reorderQty covers lead time + 7 days + safety days of demand, minus what's available; 0 when risk is low
 * (more than a week of cover — no point topping up to a target level yet).
 */
export function stockPlan(p: { stock: number; reserved: number; demand7: number; leadTimeDays: number; safetyDays?: number }) {
  const available = p.stock - p.reserved;
  const daily = Math.max(0, p.demand7) / 7;
  const daysOfCover = daily > 0 ? Math.max(0, available) / daily : Infinity;
  const risk: Risk = available <= 0 || daysOfCover < p.leadTimeDays ? 'high' : daysOfCover < 7 ? 'medium' : 'low';
  const reorderQty = risk === 'low' ? 0 : Math.max(0, Math.ceil(daily * (p.leadTimeDays + 7 + (p.safetyDays ?? 3)) - available));
  return { available, daysOfCover: Number.isFinite(daysOfCover) ? Math.round(daysOfCover * 10) / 10 : null, risk, reorderQty };
}

// ---------- order extraction ----------

const WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12 };
const qty = z.preprocess(v => (typeof v === 'string' && WORDS[v.trim().toLowerCase()]) || v, z.coerce.number().int().positive().max(1000));

/** Shape Gemma must return. Anything else is rejected before touching the DB. */
export const Extraction = z.object({
  customer: z.string().trim().min(1).max(80),
  items: z.array(z.object({ product: z.string().trim().min(1).max(80), quantity: qty })).min(1).max(20),
  delivery_text: z.string().trim().max(60).nullish(),
});
export type Extraction = z.infer<typeof Extraction>;

/** Payload for the confirm endpoint (the only order write path). */
export const OrderInput = z.object({
  customerId: z.string().max(40).nullish(),
  customerName: z.string().trim().min(1).max(80),
  items: z.array(z.object({ sku: z.string().min(1).max(40), quantity: z.number().int().positive().max(1000) })).min(1).max(20),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));

type P = { _id: string; name: string; aliases?: string[] };
/** Best product by token overlap with name+aliases; null if nothing convincing (score < 0.5). */
// ponytail: token-overlap matcher, swap for embeddings if the catalogue grows past ~100 SKUs
export function matchProduct<T extends P>(query: string, products: T[]): T | null {
  const q = norm(query);
  if (!q.length) return null;
  let best: T | null = null, bestScore = 0;
  for (const p of products) {
    const vocab = new Set(norm([p.name, ...(p.aliases ?? [])].join(' ')));
    const score = q.filter(t => vocab.has(t)).length / q.length;
    if (score > bestScore) [best, bestScore] = [p, score];
  }
  return bestScore >= 0.5 ? best : null;
}

export function matchCustomer<T extends { _id: string; name: string }>(name: string, customers: T[]): T | null {
  const q = norm(name);
  return customers.find(c => norm(c.name).join(' ') === q.join(' ')) ?? customers.find(c => q.length === 1 && norm(c.name)[0] === q[0]) ?? null;
}

// ---------- dates ----------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Resolve a delivery phrase against `today` (YYYY-MM-DD). Returns null when unsure — never guesses. */
export function resolveDate(text: string | null | undefined, today: string): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return m[0];
  if (/day after tomorrow/.test(t)) return addDays(today, 2);
  if (/\b(tomorrow|tmrw|kal)\b/.test(t)) return addDays(today, 1);
  if (/\b(today|tonight|aaj)\b/.test(t)) return today;
  if ((m = t.match(/\bin (\d{1,2}) days?\b/))) return addDays(today, +m[1]);
  const dow = DAYS.findIndex(d => new RegExp(`\\b${d}\\b`).test(t));
  if (dow >= 0) {
    const cur = new Date(today + 'T00:00:00Z').getUTCDay();
    return addDays(today, ((dow - cur + 7) % 7) || 7);
  }
  // "5 oct" / "oct 5" / "5/10" (day first, Indian convention); rolls to next year if already past
  let day: number | undefined, mon: number | undefined;
  if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})/)) && MONTHS.includes(m[2])) [day, mon] = [+m[1], MONTHS.indexOf(m[2])];
  else if ((m = t.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2})\b/)) && MONTHS.includes(m[1])) [day, mon] = [+m[2], MONTHS.indexOf(m[1])];
  else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/))) [day, mon] = [+m[1], +m[2] - 1];
  if (day === undefined || mon === undefined || mon < 0 || mon > 11 || day < 1 || day > 31) return null;
  let y = +today.slice(0, 4);
  let iso = `${y}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (iso < today) iso = `${++y}${iso.slice(4)}`;
  return Number.isNaN(Date.parse(iso)) || new Date(iso).getUTCDate() !== day ? null : iso;
}

// ---------- daily attention ----------

export type OrderFlag = 'overdue' | 'due today' | 'due tomorrow' | 'no delivery date';
/** Why a pending order needs action now; null = due later, nothing to do yet. */
export function orderFlag(deliveryDate: string | null, today: string): OrderFlag | null {
  if (!deliveryDate) return 'no delivery date';
  if (deliveryDate < today) return 'overdue';
  if (deliveryDate === today) return 'due today';
  return deliveryDate === addDays(today, 1) ? 'due tomorrow' : null;
}

/** "N things need your attention" = high-risk products + pending orders with a flag + significant supplier savings. */
export function attention(products: { risk: Risk }[], pendingOrders: { deliveryDate: string | null }[], opportunities: { significant: boolean }[], today: string) {
  const highRisk = products.filter(p => p.risk === 'high').length;
  const orders = pendingOrders.filter(o => orderFlag(o.deliveryDate, today)).length;
  const suppliers = opportunities.filter(o => o.significant).length;
  return { total: highRisk + orders + suppliers, highRisk, orders, suppliers };
}

// ---------- user-facing formatting ----------

export const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
export const units = (n: number) => { const r = Math.round(n); return `${r} unit${r === 1 ? '' : 's'}`; };
export const shortDate = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const methodLabel = (m: string) => m === 'tabpfn' ? 'TabPFN forecast' : 'moving-average forecast (TabPFN unavailable)';
/** Rejects model text that leaks field names / ids: camelCase, snake_case, "Demand7"/"P01", "sku", JSON brackets. */
export const looksClean = (s: string) => !/\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\b[A-Za-z]+\d+\b|\bsku\b|[{}[\]]/.test(s);
