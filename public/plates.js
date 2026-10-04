// Plates on the Today bar: at most `max` plates however many jobs there are, so the stack always
// fits between the shaft and the clip. Each job weight keeps at least one plate; the rest are
// shared by largest remainder in proportion to job counts. Plain browser script (no build).
const PLATE_LEVELS = ['heavy', 'mid', 'light'];
const MAX_PLATES = { wide: 24, narrow: 14 };

/** jobs (heaviest first) → [{ level, job, count }] where job is the first job the plate stands for. */
function loadPlates(jobs, max = MAX_PLATES.wide) {
  const groups = PLATE_LEVELS.map(level => ({ level, jobs: jobs.filter(j => j.level === level) })).filter(g => g.jobs.length);
  const total = groups.reduce((a, g) => a + g.jobs.length, 0);
  if (!total) return [];
  const cap = Math.max(groups.length, Math.min(max, total));
  for (const g of groups) { g.exact = g.jobs.length / total * cap; g.n = Math.max(1, Math.floor(g.exact)); }
  let left = cap - groups.reduce((a, g) => a + g.n, 0);
  for (const g of [...groups].sort((a, b) => (b.exact - b.n) - (a.exact - a.n))) if (left > 0 && g.n < g.jobs.length) { g.n++; left--; }
  while (left < 0) { const g = groups.filter(x => x.n > 1).sort((a, b) => b.n - a.n)[0]; g.n--; left++; }
  return groups.flatMap(g => Array.from({ length: g.n }, (_, i) => {
    const from = Math.floor(i * g.jobs.length / g.n), to = Math.floor((i + 1) * g.jobs.length / g.n);
    return { level: g.level, job: g.jobs[from], count: to - from };
  }));
}
