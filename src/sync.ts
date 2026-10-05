// Atlas (Mongo) → Tiger: delivered orders upsert into analytics. Idempotent by (orderId, sku).
import { col, TZ, type Order } from './db.ts';
import { ensureTiger, poolForSync, refreshDemandAggregates } from './tiger.ts';
import { log } from './integrations.ts';

export type DeliveredLine = { orderId: string; sku: string; day: string; qty: number };

/** Pure: expand a delivered order into Tiger upsert rows (one per line item). */
export function orderToLines(order: Pick<Order, '_id' | 'items'> & { deliveredAt?: Date | string | null }): DeliveredLine[] {
  const day = (order.deliveredAt ? new Date(order.deliveredAt) : new Date()).toLocaleDateString('en-CA', { timeZone: TZ }); // shop's day, same as Atlas sales
  return order.items.map(i => ({ orderId: order._id, sku: i.sku, day, qty: i.quantity }));
}

/** Idempotent upsert into Tiger order_sales + bump sales_daily. */
export async function upsertOrderLines(lines: DeliveredLine[]) {
  const st = await ensureTiger();
  if (!st.ok) return { ok: false as const, upserted: 0, detail: st.detail };
  const p = poolForSync();
  if (!p || !lines.length) return { ok: true as const, upserted: 0, detail: 'nothing to sync' };
  const c = await p.connect();
  let upserted = 0;
  try {
    await c.query('BEGIN');
    for (const L of lines) {
      const prev = await c.query(`SELECT qty FROM order_sales WHERE order_id = $1 AND sku = $2`, [L.orderId, L.sku]);
      const oldQty = Number(prev.rows[0]?.qty ?? 0);
      await c.query(
        `INSERT INTO order_sales (order_id, sku, day, qty) VALUES ($1,$2,$3::timestamptz,$4)
         ON CONFLICT (order_id, sku) DO UPDATE SET day = EXCLUDED.day, qty = EXCLUDED.qty`,
        [L.orderId, L.sku, L.day + 'T00:00:00Z', L.qty],
      );
      const delta = L.qty - oldQty;
      if (delta !== 0) {
        await c.query(
          `INSERT INTO sales_daily (day, sku, qty) VALUES ($1::timestamptz,$2,$3)
           ON CONFLICT (day, sku) DO UPDATE SET qty = sales_daily.qty + $3`,
          [L.day + 'T00:00:00Z', L.sku, delta],
        );
      }
      upserted++;
    }
    await c.query('COMMIT');
    await refreshDemandAggregates();
    return { ok: true as const, upserted, detail: `upserted ${upserted} lines` };
  } catch (e: any) {
    await c.query('ROLLBACK');
    return { ok: false as const, upserted: 0, detail: e.message };
  } finally { c.release(); }
}

export async function syncDeliveredOrder(order: Order & { deliveredAt?: Date }) {
  return upsertOrderLines(orderToLines(order));
}

/** Backfill all delivered Atlas orders into Tiger (idempotent). */
export async function backfillDeliveredOrders() {
  const orders = await col.orders.find({ status: 'delivered' }).toArray();
  const lines = orders.flatMap(o => orderToLines({ ...o, deliveredAt: o.createdAt }));
  return upsertOrderLines(lines);
}

/** Periodic fallback when change streams are unavailable. */
export async function periodicOrderSync() {
  const r = await backfillDeliveredOrders();
  log.info(r, 'periodic Atlas→Tiger order sync');
  return r;
}

let watching = false;
/** Watch Atlas orders; on status→delivered, upsert into Tiger. No-op if already watching / streams unavailable. */
export async function startOrderChangeStream() {
  if (watching) return { mode: 'already' as const };
  try {
    const stream = col.orders.watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }], { fullDocument: 'updateLookup' });
    watching = true;
    stream.on('change', async (ev: any) => {
      const doc = ev.fullDocument as Order | undefined;
      if (!doc || doc.status !== 'delivered') return;
      const r = await syncDeliveredOrder({ ...doc, deliveredAt: new Date() });
      if (!r.ok) log.warn(r, 'change-stream Tiger upsert failed');
    });
    stream.on('error', (e: Error) => {
      watching = false;
      log.warn({ err: e.message }, 'change stream failed — falling back to periodic sync');
      setInterval(() => { periodicOrderSync().catch(() => {}); }, Number(process.env.TIGER_SYNC_INTERVAL_MS ?? 300_000));
    });
    return { mode: 'change-stream' as const };
  } catch (e: any) {
    log.warn({ err: e.message }, 'change streams unavailable — periodic sync');
    setInterval(() => { periodicOrderSync().catch(() => {}); }, Number(process.env.TIGER_SYNC_INTERVAL_MS ?? 300_000));
    return { mode: 'periodic' as const, detail: e.message };
  }
}
