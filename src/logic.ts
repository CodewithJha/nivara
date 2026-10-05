// Pure, deterministic business rules. No I/O. Everything numeric the UI shows comes from here.
import { z } from 'zod';

// ---------- forecast fallback + stock rules ----------

/** Mean of the last `window` days × 7. Deterministic fallback when TabPFN is unavailable. */
export function movingAverage7(daily: number[], window = 14): number {
  const tail = daily.slice(-window);
  if (!tail.length) return 0;
  return Math.round((tail.reduce((a, b) => a + b, 0) / tail.length) * 7 * 10) / 10;
}

// ---------- precomputed TabPFN runs ----------
// Hosts without Python (Render) can't run TabPFN. `npm run forecast:publish` runs it elsewhere and stores the
// per-SKU predictions in Mongo (`forecastRuns`); the server reuses the newest fresh run instead of a moving average.

export type ForecastRun = { model: string; package?: string; asOf: string; historyDays: number; skus: number; of: number; pred: Record<string, number>; createdAt: Date | string };

/** A published laptop run stays in use for 30 days (hosts without Python can't refit); Health shows the day it was worked out. */
export const RUN_MAX_AGE_HOURS = 24 * 30;

/** Usable = has predictions and is younger than maxAgeHours. */
export function freshRun(run: Pick<ForecastRun, 'pred' | 'createdAt'> | null | undefined, now = new Date(), maxAgeHours = RUN_MAX_AGE_HOURS): boolean {
  if (!run?.pred || !Object.keys(run.pred).length) return false;
  const age = now.getTime() - new Date(run.createdAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeHours * 36e5;
}

/** Run predictions per SKU; SKUs the run doesn't cover (or bad values) get the moving average and are listed in `uncovered`. */
export function mergeRunPred(series: Record<string, number[]>, runPred: Record<string, number>) {
  const pred: Record<string, number> = {}, uncovered: string[] = [];
  for (const [sku, daily] of Object.entries(series)) {
    const v = runPred[sku];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) pred[sku] = v;
    else { pred[sku] = movingAverage7(daily); uncovered.push(sku); }
  }
  return { pred, uncovered };
}

/** /api/health entry for TabPFN, from the newest forecast doc: live (ran here) | precomputed (published run) | fallback. */
export function tabpfnHealth(f: { method?: string; model?: string; createdAt?: Date | string; fallbackReason?: string; precomputed?: { at: Date | string; skus: number; of: number } } | null | undefined) {
  if (!f) return { status: 'fallback', detail: 'no forecast yet' };
  if (f.method !== 'tabpfn') return { status: 'fallback', detail: `last forecast: ${f.method}${f.fallbackReason ? ` (${f.fallbackReason.slice(0, 120)})` : ''}` };
  const at = new Date(f.precomputed?.at ?? f.createdAt ?? 0).toISOString();
  return f.precomputed
    ? { status: 'live', mode: 'precomputed', model: f.model, at, detail: `${f.model ?? 'TabPFN'} forecast precomputed ${at} (${f.precomputed.skus}/${f.precomputed.of} products), served from MongoDB` }
    : { status: 'live', mode: 'live', model: f.model, at, detail: `${f.model ?? 'TabPFN'} forecast ran on this server ${at}` };
}

export type Risk = 'high' | 'medium' | 'low';

/**
 * high   = runs out before a reorder placed today could arrive (cover < lead time)
 * medium = runs out within 7 days
 * reorderQty covers lead time + 7 days + safety days of demand, minus what's available; 0 when risk is low
 * (more than a week of cover — no point topping up to a target level yet).
 */
// ---------- online prices ----------
// Shopping results mix sachets, other brands and bundles. A listing only counts as a comparable price when it is
// within half to double our price and, if the product name has a distinctive word (usually the brand), mentions it.
const GENERIC = new Set('whey protein powder isolate concentrate bar bars tablets tablet capsules capsule gold standard premium ultra with and for the flavour flavor chocolate vanilla strawberry cream pack plus mass gainer creatine monohydrate omega oil fish vitamin multivitamin pre workout performance high nutrition daily sugar free natural pure raw'.split(' '));
export function comparableOffer<T extends { price: number; title?: string }>(name: string, price: number, offers: T[]): T | null {
  const words = (name.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(w => !GENERIC.has(w)).slice(0, 2);
  const ok = offers.filter(o => o.price >= price * 0.5 && o.price <= price * 2 && (!words.length || words.some(w => String(o.title ?? '').toLowerCase().includes(w))));
  return ok.toSorted((a, b) => a.price - b.price)[0] ?? null;
}

/** In-app morning brief (no Temporal): due once a day from 08:00 shop time. */
export const MORNING_HOUR = 8;
export const morningDue = (hour: number, lastDay: string | undefined, day: string) => hour >= MORNING_HOUR && lastDay !== day;

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

/** Forms of address that follow a name in Hinglish orders ("Rahul bhai", "Priya ji"); not part of the name. */
const HONORIFICS = new Set(['bhai', 'bhaiya', 'bhaisaab', 'ji', 'sir', 'madam', 'maam', 'didi', 'bhabhi', 'uncle', 'aunty']);
export function matchCustomer<T extends { _id: string; name: string }>(name: string, customers: T[]): T | null {
  const q = norm(name).filter(w => !HONORIFICS.has(w));
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
  // Hinglish voice notes come back in Devanagari too (कल, आज, परसों); \b does not see Devanagari letters
  const hi = (w: string) => new RegExp(`(^|[\\s,.।])${w}($|[\\s,.।])`).test(t);
  if (/day after tomorrow|\bparso[n]?\b/.test(t) || hi('परसों')) return addDays(today, 2);
  if (/\b(tomorrow|tmrw|kal)\b/.test(t) || hi('कल')) return addDays(today, 1);
  if (/\b(today|tonight|aaj)\b/.test(t) || hi('आज')) return today;
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

// ---------- supplier savings ----------

// Seeded quotes mostly run 95–105% of cost with a few 8–15% deals (scripts/import/suppliers.config.ts); costs span ~₹30 (bars) to ~₹5,000 (2.5 kg whey).
// ₹10 alone would flag a 0.8% saving on whey; 5% alone would flag ₹5 on a ₹56 bar. Require both.
export const MIN_SUPPLIER_SAVING_RUPEES = Number(process.env.MIN_SUPPLIER_SAVING_RUPEES ?? 10);
export const MIN_SUPPLIER_SAVING_PERCENT = Number(process.env.MIN_SUPPLIER_SAVING_PERCENT ?? 5);

/**
 * Cheapest valid, unblocked quote below current cost. significant = saving ≥ ₹MIN per unit AND ≥ MIN% of current cost.
 * Blocked suppliers and zero/negative/non-numeric prices are ignored. null = no cheaper valid quote.
 */
export function bestQuote<Q extends { unitCost: number; blocked: boolean }>(currentCost: number, quotes: Q[]) {
  if (!(Number.isFinite(currentCost) && currentCost > 0)) return null;
  const best = quotes.filter(q => !q.blocked && Number.isFinite(q.unitCost) && q.unitCost > 0 && q.unitCost < currentCost).sort((a, b) => a.unitCost - b.unitCost)[0];
  if (!best) return null;
  const savingPerUnit = currentCost - best.unitCost, pct = (savingPerUnit / currentCost) * 100;
  return { best, savingPerUnit, savingPercent: Math.round(pct * 10) / 10, significant: savingPerUnit >= MIN_SUPPLIER_SAVING_RUPEES && pct >= MIN_SUPPLIER_SAVING_PERCENT };
}

/** "I don't buy from Supplier C" → target words + the real supplier they match (if any). */
export function blockTarget<S extends { _id: string; name: string }>(text: string, suppliers: S[]) {
  const m = text.match(/(?:don'?t|do not|never|stop)\s+(?:buy|order|purchase)\w*\s+from\s+(.+?)(?:[.!,]|$)|avoid\s+(.+?)(?:[.!,]|$)|block\s+(.+?)(?:[.!,]|$)/i);
  const target = m?.slice(1).find(Boolean)?.trim();
  if (!target) return null;
  const t = target.toLowerCase(), bare = t.replace(/^supplier\s+/, '');
  const word = new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return { target, supplier: suppliers.find(s => s.name.toLowerCase().includes(t)) ?? suppliers.find(s => s._id.toLowerCase() === bare || word.test(s.name.toLowerCase())) ?? null };
}

/** Turn validated extraction into a draft the user confirms. Flags every unresolved piece. */
export function buildDraft<Pr extends P & { price: number; stock: number }, C extends { _id: string; name: string }>(
  ex: Extraction, products: Pr[], customers: C[], today: string,
) {
  const problems: string[] = [];
  const cust = matchCustomer(ex.customer, customers);
  if (!cust) problems.push(`${ex.customer} is a new customer. They will be added when you save.`);
  const items = ex.items.map(i => {
    const p = matchProduct(i.product, products);
    if (!p) problems.push(`No product matches "${i.product}". Check the spelling in the message.`);
    else if (p.stock < i.quantity) problems.push(`Only ${p.stock} ${p.name} in stock; the message asks for ${i.quantity}.`);
    return { requested: i.product, quantity: i.quantity, product: p && { sku: p._id, name: p.name, price: p.price, stock: p.stock } };
  });
  const deliveryDate = resolveDate(ex.delivery_text, today);
  if (ex.delivery_text && !deliveryDate) problems.push(`Couldn't work out a delivery date from "${ex.delivery_text}". Add a day or date to the message.`);
  const total = items.reduce((s, i) => s + (i.product ? i.product.price * i.quantity : 0), 0);
  return { customer: { name: cust?.name ?? ex.customer, id: cust?._id ?? null, isNew: !cust }, items, deliveryText: ex.delivery_text ?? null, deliveryDate, total, problems };
}
