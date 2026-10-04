/**
 * Seeded suppliers and how each one quotes. Ratios are unitCost / the shop's current cost.
 * Most quotes sit within ±5% of what the shop pays; a few are genuine deals (8–15% cheaper).
 * Supplier C is cheaper on average but slow, so its quotes carry a longer lead time.
 */
export type QuoteProfile = {
  /** Share of the catalogue this supplier quotes at all (deterministic per sku). */
  coverage: number;
  /** Usual quote ratio vs current cost. */
  band: [number, number];
  /** Chance a quote is a genuine deal, drawn from dealBand instead. */
  dealChance: number;
  dealBand: [number, number];
  /** Delivery days this supplier quotes. */
  leadTimeDays: [number, number];
};

export type SupplierSeed = { _id: string; name: string; contact: string; quoting: QuoteProfile };

export const SUPPLIERS: SupplierSeed[] = [
  { _id: 'S1', name: 'FitFuel Distributors', contact: 'Lucknow wholesale market',
    quoting: { coverage: 0.45, band: [0.97, 1.05], dealChance: 0.035, dealBand: [0.86, 0.92], leadTimeDays: [3, 5] } },
  { _id: 'S2', name: 'GymGear Wholesale', contact: 'Delhi, ships in 3 days',
    quoting: { coverage: 0.4, band: [0.96, 1.05], dealChance: 0.035, dealBand: [0.85, 0.91], leadTimeDays: [3, 4] } },
  { _id: 'S3', name: 'NutriHub India', contact: 'Authorised supplements distributor',
    quoting: { coverage: 0.5, band: [0.99, 1.05], dealChance: 0.015, dealBand: [0.88, 0.92], leadTimeDays: [2, 4] } },
  { _id: 'S4', name: 'Supplier C (Sports Mart)', contact: 'Kanpur, cheap but delays',
    quoting: { coverage: 0.3, band: [0.95, 1.03], dealChance: 0.1, dealBand: [0.85, 0.9], leadTimeDays: [8, 12] } },
];
