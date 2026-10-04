/** Manual INR retail estimates when Open Prices has no match (by productType). */
export const MANUAL_PRICE: Record<string, number> = {
  whey: 2499,
  creatine: 899,
  multivitamin: 499,
  omega: 799,
  bcaa: 1199,
  preworkout: 1499,
  ayurvedic: 349,
  other: 999,
};

export const MANUAL_COST_RATIO = 0.72;

export const PRODUCT_TYPES = ['whey', 'creatine', 'multivitamin', 'omega', 'bcaa', 'preworkout', 'ayurvedic', 'other'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** Google Trends query per productType (India). */
export const TREND_QUERIES: Record<ProductType, string> = {
  whey: 'whey protein',
  creatine: 'creatine',
  multivitamin: 'multivitamin',
  omega: 'omega 3',
  bcaa: 'bcaa',
  preworkout: 'pre workout',
  ayurvedic: 'chyawanprash',
  other: 'protein supplement',
};

export const KEEP_RE = /whey|protein|creatine|vitamin|bcaa|omega|chyawanprash|mass|pre-?workout/i;
export const UA = 'Nivara/0.1 (https://github.com; Hacktoberfest shop-ops; contact=nivara)';
export const ACCESS_DATE = '2026-10-04';

export function productType(name: string, cats = ''): ProductType {
  const s = `${name} ${cats}`.toLowerCase();
  if (/pre[- ]?workout|preworkout/.test(s)) return 'preworkout';
  if (/creatine/.test(s)) return 'creatine';
  if (/bcaa|amino/.test(s)) return 'bcaa';
  if (/omega|fish oil/.test(s)) return 'omega';
  if (/vitamin|multivitamin/.test(s)) return 'multivitamin';
  if (/chyawanprash|ayurved/.test(s)) return 'ayurvedic';
  if (/whey|protein|mass|gainer|isolate|casein/.test(s)) return 'whey';
  return 'other';
}

export function categoryFor(t: ProductType) {
  return t === 'ayurvedic' ? 'food' : t === 'other' ? 'accessories' : 'powder';
}
