// Seller-facing copy helpers. Everything a shop owner reads goes through these: whole units, ₹ with Indian grouping,
// no bracketed asides, no system words. Pure functions, no I/O.

export const inr = (n: number) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
/** Whole units only: 0.28 → "0", 14.94 → "15". */
export const whole = (n: number | null | undefined) => Math.round(Number(n) || 0);
export const units = (n: number) => { const r = whole(n); return `${r} unit${r === 1 ? '' : 's'}`; };
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const pct = (n: number) => `${whole(n)}%`;
/** "Supplier C (Sports Mart)" → "Supplier C, Sports Mart". */
export const displayName = (s: string | null | undefined) => String(s ?? '').replace(/\s*\(([^()]+)\)\s*$/, ', $1').trim();

/** Words and patterns that must never reach a seller screen or a public API response. */
export const INTERNAL = /\b(trace ?id|traceId|fallback|proxy|tabpfn|hybrid-fts|pgvector|mastra|keyword[- ]router|json[- ]router|gemma-json|route error|accessDate|fetchedAt|data as of|stack trace|api[_ ]?key|mongodb(\+srv)?:\/\/|postgres(ql)?:\/\/|localhost|127\.0\.0\.1|ECONNREFUSED|undefined|NaN)\b|\[object Object\]|\bat [\w.<>]+ \(.*:\d+:\d+\)/i;
export const leaks = (s: string) => INTERNAL.test(s);

/**
 * Clean text written elsewhere (cached briefs, model summaries) for a seller screen:
 * drops bracketed asides and forecast labels, rounds "0.28 sold"-style figures, tidies spaces.
 */
export function cleanCopy(text: string) {
  let s = String(text ?? '')
    .replace(/\s*\((?:[^()]*?(?:tabpfn|forecast|fallback|proxy|moving-average|gemma|database)[^()]*)\)/gi, '')
    .replace(/~?(\d+\.\d+)(?=\s*(?:sold|units?|a day|days?|left|expected|to order)\b)/gi, (_m, n: string) => String(whole(Number(n))))
    .replace(/(\d+)\.\d+%/g, (_m, n: string) => `${Math.round(Number(_m.slice(0, -1)))}%`);
  // short asides become ", aside"; long ones (or nested) are dropped
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/\s*\(([^()]*)\)/g, (_m, inner: string) => { const t = inner.trim(); return t && !t.includes(',') && t.split(/\s+/).length <= 4 ? `, ${t}` : ''; });
  }
  return s
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/,([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n').filter(l => !/\b(tabpfn|fallback|proxy|search-interest)\b/i.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split an answer into a short lead (1–3 sentences) and bullet lines, for structured display. */
export function splitAnswer(text: string) {
  const lines = cleanCopy(text).split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[•\-*]\s/.test(l)).map(l => l.replace(/^[•\-*]\s+/, ''));
  const lead = lines.filter(l => !/^[•\-*]\s/.test(l)).join(' ');
  return { lead, bullets };
}
