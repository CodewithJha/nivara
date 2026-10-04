/**
 * Manual INR price estimate for a catalogue row with no Open Prices match:
 * retail-form band (pricing.config.ts) × pack size parsed from OFF `quantity` × brand tier,
 * clamped to realistic MRP and rounded to Indian price endings. Deterministic per product code.
 */
import type { ProductType } from './config.ts';
import {
  BRAND_TIERS, COST_RATIO_BAND, COUNT_UNITS, FORM_RULES, MASS_UNITS, PACK_ELASTICITY, PROFILES,
  SERVING_UNITS, SMALL_PRICE_LIMIT, TYPE_PROFILE, UNKNOWN_BRAND_POSITION, type PriceProfile, type ProfileKey,
} from './pricing.config.ts';
import { within } from './hash.ts';

export type ParsedPack = { grams?: number; count?: number; servings?: number; bare?: number };
export type Pack = { amount: number; unit: 'g' | 'units'; source: 'quantity' | 'default' };
export type PriceEstimate = { price: number; cost: number; profile: ProfileKey; pack: Pack; tier: string };
export type EstimateInput = { code: string; name: string; brands?: string; quantity?: string; productType: ProductType };

/** "1.75kg", "2 lb (909 g)", "6 bars, 50g each", "60 capsules", "500g 14 servings", "950" → numbers. */
export function parsePack(quantity = ''): ParsedPack {
  const s = quantity.toLowerCase().replace(/(\d),(\d{3})\b/g, '$1$2');
  const out: ParsedPack = {};
  for (const [, num, rawUnit = ''] of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)?/g)) {
    const n = Number(num), u = rawUnit.trim();
    if (!(n > 0)) continue;
    if (u in MASS_UNITS) out.grams ??= n * MASS_UNITS[u];
    else if (SERVING_UNITS.test(u)) out.servings ??= n;
    else if (COUNT_UNITS.test(u)) out.count ??= n;
    else if (!u) out.bare ??= n;
  }
  // "6 bars, 50g each" / "6 x 50 g": the mass is per unit.
  if (out.grams && out.count && out.count > 1 && /each|\d\s*x\s*\d/.test(s)) out.grams *= out.count;
  return out;
}

/** Pack in the profile's basis (grams or units); falls back to the profile default when missing or implausible. */
export function packFor(profile: PriceProfile, parsed: ParsedPack): Pack {
  const unit = profile.basis === 'mass' ? 'g' : 'units';
  const units = parsed.count ?? parsed.servings;
  const amount = profile.basis === 'mass'
    ? parsed.grams ?? (units ? units * profile.gramsPerUnit : parsed.bare)
    : parsed.count ?? (parsed.grams ? parsed.grams / profile.gramsPerUnit : parsed.bare);
  const [lo, hi] = profile.packRange;
  return amount && amount >= lo && amount <= hi
    ? { amount: Math.round(amount), unit, source: 'quantity' }
    : { amount: profile.defaultPack, unit, source: 'default' };
}

/** Retail form for pricing: bars, RTD shakes, oats and gainers get their own bands inside "whey". */
export function profileFor(p: Pick<EstimateInput, 'name' | 'brands' | 'productType'>, parsed: ParsedPack = {}): ProfileKey {
  const text = `${p.name} ${p.brands ?? ''}`;
  const rule = FORM_RULES.find(r => r.type === p.productType && r.re.test(text) && !(r.maxPack && (parsed.grams ?? 0) > r.maxPack));
  return rule?.profile ?? TYPE_PROFILE[p.productType] ?? 'other';
}

/** Where in the band the product sits (0..1): brand tier range, stable per code inside it. */
export function bandPosition(p: Pick<EstimateInput, 'code' | 'name' | 'brands'>) {
  const text = `${p.brands ?? ''} ${p.name}`;
  const t = BRAND_TIERS.find(b => b.re.test(text));
  return { tier: t?.tier ?? 'unknown', position: within(t?.position ?? UNKNOWN_BRAND_POSITION, 'tier', p.code) };
}

/** Indian MRP endings: under ₹200 → …9 (₹49, ₹89); otherwise …49 / …99 (₹1,849, ₹2,499). */
export function roundIndian(x: number) {
  return x < SMALL_PRICE_LIMIT ? Math.max(9, Math.round((x + 1) / 10) * 10 - 1) : Math.round((x + 1) / 50) * 50 - 1;
}

const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, x));

export function estimatePrice(p: EstimateInput): PriceEstimate {
  const parsed = parsePack(p.quantity);
  const key = profileFor(p, parsed);
  const profile: PriceProfile = PROFILES[key];
  const pack = packFor(profile, parsed);
  const { tier, position } = bandPosition(p);
  const [lo, hi] = profile.band;
  const scaled = (lo + (hi - lo) * position) * (pack.amount / profile.refPack) ** (profile.packElasticity ?? PACK_ELASTICITY);
  const price = clamp(roundIndian(clamp(scaled, profile.clamp)), profile.clamp);
  const cost = Math.round(price * within(profile.margin ?? COST_RATIO_BAND, 'margin', p.code));
  return { price, cost, profile: key, pack, tier };
}
