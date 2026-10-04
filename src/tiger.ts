// Tiger Data (TimescaleDB + pgvector): sales hypertables, continuous aggregates, hybrid catalog search.
import pg from 'pg';
import type { Product, Sale } from './db.ts';
import { log, span } from './integrations.ts';

const g = globalThis as typeof globalThis & { __nivaraTiger?: pg.Pool | null | undefined; __nivaraTigerReady?: Promise<{ ok: boolean; detail: string }> };

export const tigerConfigured = () => !!process.env.TIGER_DATABASE_URL?.trim();

function pool(): pg.Pool | null {
  if (!tigerConfigured()) return null;
  if (g.__nivaraTiger !== undefined) return g.__nivaraTiger;
  try {
    // Tiger Cloud TLS: pg v8 treats sslmode=require as verify-full; use libpq-compat + explicit ssl.
    const u = new URL(process.env.TIGER_DATABASE_URL!);
    u.searchParams.set('sslmode', 'require');
    u.searchParams.set('uselibpqcompat', 'true');
    g.__nivaraTiger = new pg.Pool({
      connectionString: u.toString(),
      max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000,
      ssl: { rejectUnauthorized: false },
    });
  } catch {
    g.__nivaraTiger = null;
  }
  return g.__nivaraTiger;
}

/** Exposed for Atlas→Tiger sync module (same cached pool). */
export const poolForSync = () => pool();

export async function refreshDemandAggregates() {
  const p = pool();
  if (!p) return;
  try { await p.query(`CALL refresh_continuous_aggregate('sales_demand_7d', NULL, NULL)`); } catch { /* empty ok */ }
  try { await p.query(`CALL refresh_continuous_aggregate('sales_demand_28d', NULL, NULL)`); } catch { /* empty ok */ }
}

const MIGRATE = `
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS sales_daily (
  day TIMESTAMPTZ NOT NULL,
  sku TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (day, sku)
);
SELECT create_hypertable('sales_daily', by_range('day'), if_not_exists => TRUE);
CREATE TABLE IF NOT EXISTS catalog_items (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT '',
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  tags JSONB NOT NULL DEFAULT '{}',
  search_tsv TSVECTOR,
  embedding VECTOR(768)
);
CREATE INDEX IF NOT EXISTS catalog_items_tsv_idx ON catalog_items USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS catalog_items_cat_price_idx ON catalog_items (category, price);
CREATE TABLE IF NOT EXISTS order_sales (
  order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  day TIMESTAMPTZ NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, sku)
);
`;

async function migrate(client: pg.PoolClient) {
  for (const stmt of MIGRATE.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await client.query(stmt); }
    catch (e: any) {
      // hypertable may already exist / extension already created
      if (!/already exists|is already a hypertable/i.test(e.message)) throw e;
    }
  }
  // Continuous aggregates (idempotent create)
  await client.query(`
    DO $$ BEGIN
      CREATE MATERIALIZED VIEW sales_demand_7d
      WITH (timescaledb.continuous) AS
      SELECT time_bucket('7 days', day) AS bucket, sku, SUM(qty) AS qty_7d
      FROM sales_daily GROUP BY 1, 2
      WITH NO DATA;
    EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  await client.query(`
    DO $$ BEGIN
      CREATE MATERIALIZED VIEW sales_demand_28d
      WITH (timescaledb.continuous) AS
      SELECT time_bucket('28 days', day) AS bucket, sku, SUM(qty) AS qty_28d
      FROM sales_daily GROUP BY 1, 2
      WITH NO DATA;
    EXCEPTION WHEN duplicate_table THEN NULL; END $$;
  `);
  // Refresh policies (ignore if already present)
  for (const [view, start] of [['sales_demand_7d', '21 days'], ['sales_demand_28d', '84 days']] as const) {
    try { await client.query(`SELECT add_continuous_aggregate_policy('${view}', start_offset => INTERVAL '${start}', end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 day');`); }
    catch (e: any) { if (!/already exists|too small/i.test(e.message)) log.warn({ err: e.message, view }, 'cagg policy'); }
  }
}

export async function ensureTiger(): Promise<{ ok: boolean; detail: string }> {
  // ponytail: cache successful migrate; failed attempts retry next call
  if (g.__nivaraTigerReady) {
    const cached = await g.__nivaraTigerReady;
    if (cached.ok) return cached;
    g.__nivaraTigerReady = undefined;
  }
  g.__nivaraTigerReady = (async () => {
    const p = pool();
    if (!p) return { ok: false, detail: 'TIGER_DATABASE_URL unset — Mongo sales only; catalog search is keyword-only' };
    let c: pg.PoolClient | undefined;
    try {
      c = await p.connect();
      await migrate(c);
      const v = await c.query(`SELECT extname FROM pg_extension WHERE extname IN ('timescaledb','vector') ORDER BY 1`);
      const exts = v.rows.map(r => r.extname).join('+');
      return { ok: true, detail: `Timescale/pgvector ready (${exts || 'extensions ok'})` };
    } catch (e: any) {
      return { ok: false, detail: `Tiger unavailable: ${e.message.slice(0, 160)}` };
    } finally { c?.release(); }
  })();
  return g.__nivaraTigerReady;
}

export async function tigerStatus() {
  if (!tigerConfigured()) return { live: false, detail: 'TIGER_DATABASE_URL unset — Mongo sales + keyword catalog search' };
  try {
    const st = await ensureTiger();
    if (!st.ok) return { live: false, detail: st.detail };
    const p = pool()!;
    const r = await p.query(`SELECT (SELECT COUNT(*)::int FROM sales_daily) AS sales, (SELECT COUNT(*)::int FROM catalog_items) AS catalog`);
    return { live: true, detail: `${st.detail}; ${r.rows[0].sales} sales rows, ${r.rows[0].catalog} catalog rows` };
  } catch (e: any) {
    return { live: false, detail: `Tiger unreachable: ${e.message.slice(0, 140)}` };
  }
}

export async function syncSalesToTiger(sales: Sale[]) {
  const p = pool();
  if (!p || !sales.length) return { synced: 0 };
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE sales_daily');
    const batch = 500;
    for (let i = 0; i < sales.length; i += batch) {
      const slice = sales.slice(i, i + batch);
      const vals: any[] = [];
      const ph = slice.map((s, j) => {
        const o = j * 3;
        vals.push(s.date + 'T00:00:00Z', s.sku, s.qty);
        return `($${o + 1}::timestamptz, $${o + 2}, $${o + 3})`;
      });
      await c.query(`INSERT INTO sales_daily (day, sku, qty) VALUES ${ph.join(',')} ON CONFLICT (day, sku) DO UPDATE SET qty = EXCLUDED.qty`, vals);
    }
    await c.query('COMMIT');
    await refreshDemandAggregates();
    return { synced: sales.length };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
}

export async function syncCatalogToTiger(products: Product[]) {
  const p = pool();
  if (!p) return { synced: 0 };
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE catalog_items');
    for (const prod of products) {
      const text = [prod.name, ...(prod.aliases ?? []), prod.category, (prod as any).tags?.brands].filter(Boolean).join(' ');
      await c.query(
        `INSERT INTO catalog_items (sku, name, aliases, category, price, tags, search_tsv)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb, to_tsvector('english', $7))
         ON CONFLICT (sku) DO UPDATE SET name=EXCLUDED.name, aliases=EXCLUDED.aliases, category=EXCLUDED.category, price=EXCLUDED.price, tags=EXCLUDED.tags, search_tsv=EXCLUDED.search_tsv`,
        [prod._id, prod.name, prod.aliases ?? [], prod.category, prod.price, JSON.stringify((prod as any).tags ?? {}), text],
      );
    }
    await c.query('COMMIT');
    return { synced: products.length };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
}

/** Gemini embedding-001 (768-d). Returns null when key missing / call fails. */
async function embed(text: string): Promise<number[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return span('tiger.embed', 'gemini embedding', { chars: text.length }, async () => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
    const j: any = await r.json();
    const v = j.embedding?.values;
    if (!Array.isArray(v) || v.length < 8) throw new Error('bad embedding');
    return v as number[];
  }).catch(() => null);
}

export async function embedCatalog(products: Product[]) {
  const p = pool();
  if (!p || !process.env.GEMINI_API_KEY) return { embedded: 0, reason: 'GEMINI_API_KEY missing — FTS-only search' };
  let n = 0;
  for (const prod of products) {
    const text = [prod.name, ...(prod.aliases ?? []), prod.category, (prod as any).tags?.brands].filter(Boolean).join(' ');
    const v = await embed(text);
    if (!v) continue;
    await p.query(`UPDATE catalog_items SET embedding = $2::vector WHERE sku = $1`, [prod._id, `[${v.join(',')}]`]);
    n++;
  }
  return { embedded: n };
}

type SearchFilters = { maxPrice?: number; noSugar?: boolean; category?: string; q: string };

function parseQuery(raw: string): SearchFilters {
  const s = raw.toLowerCase();
  const max = s.match(/(?:under|below|<=?|less than)\s*₹?\s*(\d{2,6})/i);
  const noSugar = /\b(no sugar|sugar[- ]?free|zero sugar|without sugar)\b/i.test(s);
  const category = /\bbar/.test(s) ? 'bars' : /\b(powder|whey|creatine|gainer|bcaa|pre)/.test(s) ? 'powder' : undefined;
  const q = raw.replace(/(?:under|below|<=?|less than)\s*₹?\s*\d{2,6}/ig, '').replace(/\b(no sugar|sugar[- ]?free|zero sugar|without sugar)\b/ig, '').trim() || raw;
  return { q, maxPrice: max ? Number(max[1]) : undefined, noSugar, category };
}

/** Hybrid catalog search: Postgres FTS + optional pgvector; falls back to in-process keyword over Mongo rows when Tiger is down. */
export async function searchCatalog(query: string, limit = 8) {
  const filters = parseQuery(query);
  return span('gen_ai.execute_tool', 'execute_tool searchCatalog', { 'gen_ai.tool.name': 'searchCatalog', 'gen_ai.tool.input': query }, async set => {
    const st = await ensureTiger();
    if (st.ok) {
      const p = pool()!;
      const vec = await embed(filters.q);
      const params: any[] = [filters.q, limit];
      const text = `search_tsv @@ plainto_tsquery('english', $1)`;
      // hard filters apply to text AND vector matches (a vector hit must not slip past "under ₹3000")
      let filt = 'TRUE', cat = 'TRUE';
      if (filters.maxPrice != null) { params.push(filters.maxPrice); filt += ` AND price <= $${params.length}`; }
      // category is a guess from words like "whey": it narrows text matches only, close vector matches may sit in another category
      if (filters.category) { params.push(filters.category); cat = `category = $${params.length}`; }
      // OFF "no sugar" ≈ sugar-free / very low; 5g/100g catches bars labelled low-sugar without empty results
      if (filters.noSugar) filt += ` AND (tags->>'sugarPer100g') IS NOT NULL AND (tags->>'sugarPer100g')::float <= 5`;
      const where = `${text} AND ${cat} AND ${filt}`;
      let rows;
      if (vec) {
        params.push(`[${vec.join(',')}]`);
        const v = `$${params.length}::vector`;
        rows = await p.query(
          `SELECT sku, name, category, price, tags,
                  ts_rank(search_tsv, plainto_tsquery('english', $1)) AS text_rank,
                  (1 - (embedding <=> ${v})) AS vec_score
             FROM catalog_items
            WHERE embedding IS NOT NULL AND ((${text} AND ${cat}) OR embedding <=> ${v} < 0.55) AND ${filt}
            ORDER BY (ts_rank(search_tsv, plainto_tsquery('english', $1)) + 2 * (1 - (embedding <=> ${v}))) DESC
            LIMIT $2`,
          params,
        );
        set('mode', 'hybrid-fts+pgvector');
      } else {
        rows = await p.query(
          `SELECT sku, name, category, price, tags, ts_rank(search_tsv, plainto_tsquery('english', $1)) AS text_rank
             FROM catalog_items WHERE ${where}
            ORDER BY text_rank DESC, price ASC LIMIT $2`,
          params,
        );
        set('mode', 'fts');
      }
      // demand from continuous aggregates (latest bucket)
      const demand = await p.query(
        `SELECT d7.sku, d7.qty_7d, d28.qty_28d FROM
          (SELECT DISTINCT ON (sku) sku, qty_7d FROM sales_demand_7d ORDER BY sku, bucket DESC) d7
          LEFT JOIN (SELECT DISTINCT ON (sku) sku, qty_28d FROM sales_demand_28d ORDER BY sku, bucket DESC) d28 USING (sku)`,
      ).catch(() => ({ rows: [] as any[] }));
      const dem = Object.fromEntries(demand.rows.map((r: any) => [r.sku, { demand7: Number(r.qty_7d) || 0, demand28: Number(r.qty_28d) || 0 }]));
      const hits = rows.rows.map((r: any) => ({
        sku: r.sku, name: r.name, category: r.category, price: Number(r.price),
        sugarPer100g: r.tags?.sugarPer100g ?? null, brands: r.tags?.brands ?? '',
        ...dem[r.sku],
      }));
      set('hits', hits.length);
      return { available: true, mode: vec ? 'hybrid-fts+pgvector' : 'fts', query, filters, hits, source: 'tiger' };
    }
    // Mongo keyword fallback
    const { col } = await import('./db.ts');
    const all = await col.products.find().toArray();
    const tokens = filters.q.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const hits = all.filter(p => {
      if (filters.maxPrice != null && p.price > filters.maxPrice) return false;
      if (filters.category && p.category !== filters.category) return false;
      if (filters.noSugar && !(Number((p as any).tags?.sugarPer100g) <= 5)) return false;
      const blob = `${p.name} ${(p.aliases ?? []).join(' ')} ${p.category}`.toLowerCase();
      return tokens.every(t => blob.includes(t));
    }).slice(0, limit).map(p => ({
      sku: p._id, name: p.name, category: p.category, price: p.price,
      sugarPer100g: (p as any).tags?.sugarPer100g ?? null, brands: (p as any).tags?.brands ?? '',
    }));
    set('mode', 'mongo-keyword');
    set('hits', hits.length);
    return { available: true, mode: 'mongo-keyword', query, filters, hits, source: 'mongo-fallback', reason: st.detail };
  });
}

/** Latest 7d / 28d demand from Tiger continuous aggregates; empty when Tiger is down. */
export async function tigerDemand(): Promise<Record<string, { demand7: number; demand28: number }>> {
  const st = await ensureTiger();
  if (!st.ok) return {};
  try {
    const p = pool()!;
    const r = await p.query(
      `SELECT d7.sku, d7.qty_7d, COALESCE(d28.qty_28d, 0) AS qty_28d FROM
        (SELECT DISTINCT ON (sku) sku, qty_7d FROM sales_demand_7d ORDER BY sku, bucket DESC) d7
        LEFT JOIN (SELECT DISTINCT ON (sku) sku, qty_28d FROM sales_demand_28d ORDER BY sku, bucket DESC) d28 USING (sku)`,
    );
    return Object.fromEntries(r.rows.map((x: any) => [x.sku, { demand7: Number(x.qty_7d) || 0, demand28: Number(x.qty_28d) || 0 }]));
  } catch { return {}; }
}
