/**
 * Deterministic supplier quotes for the seed: each supplier quotes a subset of the catalogue,
 * at a ratio of current cost drawn per (supplier, sku) from suppliers.config.ts. No Math.random,
 * so re-seeding gives the same quotes and the same handful of savings opportunities.
 */
import { SUPPLIERS, type SupplierSeed } from './suppliers.config.ts';
import { unit, within } from './hash.ts';

export type Quote = { sku: string; unitCost: number; leadTimeDays: number };
type Priced = { _id: string; cost: number; supplierId: string };

export function quoteFor(s: SupplierSeed, p: Priced): Quote | null {
  if (p.supplierId === s._id || !(p.cost > 0)) return null; // the current supplier's price is the cost itself
  if (unit('covers', s._id, p._id) >= s.quoting.coverage) return null;
  const deal = unit('deal', s._id, p._id) < s.quoting.dealChance;
  const ratio = within(deal ? s.quoting.dealBand : s.quoting.band, 'ratio', s._id, p._id);
  const [lo, hi] = s.quoting.leadTimeDays;
  return { sku: p._id, unitCost: Math.round(p.cost * ratio), leadTimeDays: Math.floor(within([lo, hi + 1], 'lead', s._id, p._id)) };
}

export function buildSuppliers(products: Priced[], suppliers = SUPPLIERS) {
  return suppliers.map(({ quoting: _q, ...s }) => ({
    ...s,
    quotes: products.map(p => quoteFor(suppliers.find(x => x._id === s._id)!, p)).filter((q): q is Quote => !!q),
  }));
}
