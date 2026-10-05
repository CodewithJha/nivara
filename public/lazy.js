// Long tables render progressively. Stock and Forecast list every product (200+ rows, ~4,000 nodes as
// phone cards): the first rows come with the page, the rest join in batches as the reader scrolls near
// the end. Plain browser script (no build); nextSlices has no DOM, so it is unit-tested.
const LAZY = { first: 30, batch: 40, margin: '0px 0px 1500px 0px' };

/** Row counts per group, a cursor { g, r } and a budget of n rows → the slices to draw next and the new cursor.
 *  A slice with from 0 opens its group (draws the section); later slices append rows to it. Empty groups still open. */
function nextSlices(counts, at, n) {
  const parts = [];
  let { g, r } = at;
  while (g < counts.length && (n > 0 || counts[g] === 0)) {
    const take = Math.min(n, counts[g] - r);
    if (take > 0 || counts[g] === 0) parts.push({ g, from: r, to: r + take });
    n -= take; r += take;
    if (r >= counts[g]) { g++; r = 0; }
  }
  return { parts, at: { g, r } };
}

let lazyPending = null, lazyObs = null;
/** Stop drawing rows for the page being left. */
function lazyOff() { lazyObs?.disconnect(); lazyObs = null; lazyPending = null; }

/**
 * groups: [{ rows, row: item → '<tr>…', html: (rowsHtml, g) → the whole section, with <tbody data-lazy="g"> }].
 * Returns the html for the first rows; lazyArm(root) then fills in the rest as the reader scrolls.
 */
function progressive(groups) {
  const counts = groups.map(x => x.rows.length);
  const rows = p => groups[p.g].rows.slice(p.from, p.to).map(groups[p.g].row).join('');
  const first = nextSlices(counts, { g: 0, r: 0 }, LAZY.first);
  let at = first.at;
  const done = () => at.g >= counts.length;
  lazyPending = done() ? null : root => {
    const more = root.querySelector('.lazy-more');
    if (!more) return;
    const step = () => {
      const next = nextSlices(counts, at, LAZY.batch);
      at = next.at;
      for (const p of next.parts) {
        if (p.from === 0) more.insertAdjacentHTML('beforebegin', groups[p.g].html(rows(p), p.g));
        else root.querySelector(`[data-lazy="${p.g}"]`)?.insertAdjacentHTML('beforeend', rows(p));
      }
      if (done()) { lazyOff(); more.remove(); return true; }
    };
    if (typeof IntersectionObserver !== 'function') { while (!step()); return; }
    // Re-observing after each batch re-checks the sentinel, so a fast scroll keeps loading until it is out of reach.
    lazyObs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && !step()) { lazyObs.unobserve(more); lazyObs.observe(more); } }, { rootMargin: LAZY.margin });
    lazyObs.observe(more);
  };
  return first.parts.map(p => groups[p.g].html(rows(p), p.g)).join('') + (done() ? '' : '<div class="lazy-more" aria-hidden="true"></div>');
}
/** Call once the html from progressive() is in the page. */
function lazyArm(root) { const arm = lazyPending; lazyPending = null; arm?.(root); }
