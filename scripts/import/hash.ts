/** Deterministic hashing so seeded prices/quotes are identical on every run (no Math.random). */

/** FNV-1a 32-bit with a murmur3 finaliser (plain FNV leaves similar short keys like R01/R02 correlated). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Stable value in [0, 1) for a key; different salts give independent draws for the same key. */
export const unit = (...parts: string[]) => fnv1a(parts.join('\u241f')) / 2 ** 32;

/** Stable value in [lo, hi) for a key. */
export const within = ([lo, hi]: readonly [number, number], ...parts: string[]) => lo + (hi - lo) * unit(...parts);
