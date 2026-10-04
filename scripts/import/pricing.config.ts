/**
 * Manual INR price estimates for catalogue rows Open Prices has no match for.
 * Every number the estimator uses lives here; price-estimate.ts only does arithmetic.
 *
 * A profile prices one retail form (whey tub, protein bar, capsule bottle...). Its `band` is the
 * Indian MRP range for `refPack` units; other pack sizes scale by (pack / refPack) ^ packElasticity
 * (bigger packs are cheaper per gram). `clamp` is the sanity range for any pack of that form
 * (bounds use Indian price endings so a clamped price still looks like an MRP).
 */
import type { ProductType } from './config.ts';

export type PackBasis = 'mass' | 'count';
export type PriceProfile = {
  basis: PackBasis;
  /** Reference pack: grams (mass) or units (count). */
  refPack: number;
  /** Indian MRP range in ₹ for refPack. */
  band: [number, number];
  /** Pack assumed when OFF `quantity` is missing or unparseable. */
  defaultPack: number;
  /** Parsed packs outside this range are treated as parse noise → defaultPack. */
  packRange: [number, number];
  /** ₹ MRP sanity range after scaling. */
  clamp: [number, number];
  /** Grams per counted unit (bar, capsule, serving) to convert between bases. */
  gramsPerUnit: number;
  /** Override PACK_ELASTICITY (capsule bottles scale less steeply than tubs). */
  packElasticity?: number;
  /** Override global margin band (cost / price). */
  margin?: [number, number];
};

export const PACK_ELASTICITY = 0.9;

export const PROFILES = {
  whey:         { basis: 'mass',  refPack: 1000, band: [1800, 3500], defaultPack: 1000, packRange: [20, 5000], clamp: [79, 9999], gramsPerUnit: 33 },
  gainer:       { basis: 'mass',  refPack: 1000, band: [900, 1600],  defaultPack: 1000, packRange: [100, 6000], clamp: [299, 5999], gramsPerUnit: 100 },
  protein_bar:  { basis: 'mass',  refPack: 50,   band: [40, 120],    defaultPack: 50,   packRange: [20, 800],  clamp: [29, 999], gramsPerUnit: 50, margin: [0.7, 0.82] },
  protein_rtd:  { basis: 'mass',  refPack: 200,  band: [60, 150],    defaultPack: 200,  packRange: [20, 500],  clamp: [39, 499], gramsPerUnit: 200, margin: [0.7, 0.82] },
  protein_oats: { basis: 'mass',  refPack: 400,  band: [199, 399],   defaultPack: 400,  packRange: [100, 3000], clamp: [99, 1999], gramsPerUnit: 50 },
  creatine:     { basis: 'mass',  refPack: 250,  band: [500, 1200],  defaultPack: 250,  packRange: [50, 1000], clamp: [249, 3499], gramsPerUnit: 3 },
  bcaa:         { basis: 'mass',  refPack: 250,  band: [900, 1800],  defaultPack: 250,  packRange: [50, 1000], clamp: [399, 3999], gramsPerUnit: 10 },
  preworkout:   { basis: 'mass',  refPack: 300,  band: [900, 2500],  defaultPack: 300,  packRange: [50, 1000], clamp: [499, 4999], gramsPerUnit: 10 },
  multivitamin: { basis: 'count', refPack: 60,   band: [300, 900],   defaultPack: 60,   packRange: [10, 365],  clamp: [99, 1999], gramsPerUnit: 1.2, packElasticity: 0.75 },
  omega:        { basis: 'count', refPack: 60,   band: [400, 1200],  defaultPack: 60,   packRange: [15, 365],  clamp: [199, 2999], gramsPerUnit: 1.4, packElasticity: 0.75 },
  ayurvedic:    { basis: 'mass',  refPack: 1000, band: [330, 450],   defaultPack: 1000, packRange: [100, 2000], clamp: [199, 899], gramsPerUnit: 10 },
  other:        { basis: 'mass',  refPack: 500,  band: [499, 1499],  defaultPack: 500,  packRange: [20, 5000], clamp: [99, 4999], gramsPerUnit: 30 },
} satisfies Record<string, PriceProfile>;
export type ProfileKey = keyof typeof PROFILES;

/**
 * Retail form inside a productType, first match wins. Whey covers every "protein" row in OFF,
 * so oats/muesli, bars, ready-to-drink shakes and gainers need their own price bands
 * (oats first: "Yoga bar High Protein Muesli" is muesli, not a bar).
 * Matched against name + brands (RiteBite "Max Protein" is a bar line). `maxPack` (grams) stops "Plant Protein Shake 1 kg" (a powder) from pricing as a 200 ml bottle.
 */
export const FORM_RULES: { type: ProductType; profile: ProfileKey; re: RegExp; maxPack?: number }[] = [
  { type: 'whey', profile: 'protein_oats', re: /\boats\b|muesli/i },
  { type: 'whey', profile: 'protein_bar', re: /\bbars?\b|wafer|minis\b|max protein|rite ?bite/i },
  { type: 'whey', profile: 'protein_rtd', re: /milkshake|\bshake\b/i, maxPack: 500 },
  { type: 'whey', profile: 'gainer', re: /\bmass\b|gainer/i },
];

/** productType → default profile when no FORM_RULE matches. */
export const TYPE_PROFILE: Record<ProductType, ProfileKey> = {
  whey: 'whey', creatine: 'creatine', multivitamin: 'multivitamin', omega: 'omega',
  bcaa: 'bcaa', preworkout: 'preworkout', ayurvedic: 'ayurvedic', other: 'other',
};

/**
 * Brand tier picks where in the band a product sits (0 = band low, 1 = band high).
 * Unlisted brands get a stable position from a hash of the product code inside `unknown`.
 */
export const BRAND_TIERS: { tier: 'premium' | 'mid' | 'value'; position: [number, number]; re: RegExp }[] = [
  { tier: 'premium', position: [0.7, 1], re: /optimum nutrition|\bon\b|gold standard|muscletech|dymatize|myprotein|bsn|syntha|\bans\b|isopure|the whole truth|plix|oziva/i },
  { tier: 'mid', position: [0.4, 0.75], re: /muscleblaze|\bmb\b|biozyme|atom|asitis|as it is|wellcore|nutrabay|avvatar|yoga ?bar|phab|ritebite|max protein|hk vitals|healthkart|tata|epigamia|nourish/i },
  { tier: 'value', position: [0, 0.35], re: /patanjali|dabur|baidyanath|zandu|nakpro|bodypower|bioton|fuelone|apollo|carbamide|pintola/i },
];
export const UNKNOWN_BRAND_POSITION: [number, number] = [0.15, 0.85];

/** Global cost / price band (shop buys at 62–76% of MRP); per-profile `margin` overrides. */
export const COST_RATIO_BAND: [number, number] = [0.62, 0.76];

/** Prices below this end in 9 (₹49, ₹89); at or above it, in 49 or 99 (₹1,849, ₹2,499). */
export const SMALL_PRICE_LIMIT = 200;

/** OFF quantity unit → grams (mass) or 1 (count). ml is treated as grams (density ≈ 1). */
export const MASS_UNITS: Record<string, number> = {
  mg: 0.001, g: 1, gm: 1, gms: 1, gr: 1, grams: 1, gram: 1, kg: 1000, kgs: 1000, kilo: 1000,
  ml: 1, l: 1000, ltr: 1000, litre: 1000, liter: 1000, lb: 453.6, lbs: 453.6, oz: 28.35,
};
export const COUNT_UNITS = /^(caps?(ules?)?|tabs?(lets?)?|softgels?|gels?|n|pcs?|pieces?|bars?|sachets?|count|ct|nos?|servings?)$/i;
export const SERVING_UNITS = /^servings?$/i;
