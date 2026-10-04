#!/usr/bin/env node
/**
 * Owner import: CSV orders and/or a WhatsApp chat export (.txt).
 *
 * CSV columns (header required): customer,product,quantity,delivery_date?,status?,source?
 * WhatsApp: lines like `[DD/MM/YYYY, HH:MM:SS] Name: 2 whey protein tomorrow`
 *   → passed through Gemma extractOrder when LLM is up; otherwise a keyword draft.
 *
 * Usage:
 *   npm run import:orders -- --csv data/samples/orders.csv
 *   npm run import:orders -- --whatsapp data/samples/whatsapp.txt
 */
import { readFileSync, existsSync } from 'node:fs';
import { client, col, today, type Order } from '../src/db.ts';
import { matchCustomer, matchProduct, resolveDate } from '../src/logic.ts';
import { extractOrder } from '../src/agent.ts';

function arg(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseCsv(text: string) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map(s => s.trim().toLowerCase());
  return rows.filter(Boolean).map(line => {
    const cells = line.split(',').map(s => s.trim());
    const o: Record<string, string> = {};
    cols.forEach((c, i) => (o[c] = cells[i] ?? ''));
    return o;
  });
}

/** Very small WhatsApp export parser — keeps message bodies that look like orders. */
function whatsappMessages(text: string) {
  const re = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\]?\s*([^:]+):\s*(.+)$/i;
  return text.split(/\r?\n/).flatMap(line => {
    const m = line.match(re);
    if (!m) return [];
    const body = m[3].trim();
    if (!/\b(\d+|one|two|three|dozen|kg|whey|protein|creatine|order|bhej|chahiye)\b/i.test(body)) return [];
    return [{ customer: m[2].trim(), text: body }];
  });
}

export async function importOrders({ csvPath, whatsappPath }: { csvPath?: string; whatsappPath?: string }) {
  const [products, customers] = await Promise.all([col.products.find().toArray(), col.customers.find().toArray()]);
  if (!products.length) throw new Error('No products — import catalogue first');
  const created: Order[] = [];
  let custSeq = customers.length;

  const ensureCustomer = async (name: string) => {
    const hit = matchCustomer(name, [...customers, ...created.map(o => ({ _id: o.customerId, name: o.customerName }))]);
    if (hit) return hit;
    custSeq++;
    const c = { _id: `C${String(custSeq).padStart(2, '0')}`, name, channel: 'whatsapp' as const, demo: false };
    customers.push(c);
    await col.customers.insertOne(c);
    return c;
  };

  if (csvPath) {
    if (!existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
    for (const row of parseCsv(readFileSync(csvPath, 'utf8'))) {
      const p = matchProduct(row.product, products);
      if (!p) continue;
      const c = await ensureCustomer(row.customer || 'Walk-in');
      const qty = Math.max(1, Number(row.quantity) || 1);
      const order: Order = {
        _id: 'O' + Date.now().toString(36).toUpperCase() + created.length,
        customerId: c._id, customerName: c.name,
        items: [{ sku: p._id, name: p.name, quantity: qty, price: p.price }],
        total: p.price * qty,
        status: (row.status === 'delivered' || row.status === 'cancelled' ? row.status : 'pending') as Order['status'],
        deliveryDate: resolveDate(row.delivery_date || row.delivery, today()),
        createdAt: new Date(), source: row.source || 'owner-csv', demo: false,
      };
      created.push(order);
    }
  }

  if (whatsappPath) {
    if (!existsSync(whatsappPath)) throw new Error(`WhatsApp export not found: ${whatsappPath}`);
    for (const msg of whatsappMessages(readFileSync(whatsappPath, 'utf8'))) {
      try {
        const { draft } = await extractOrder(`${msg.customer}: ${msg.text}`);
        const items = (draft?.items ?? []).filter((i: any) => i.product?.sku).map((i: any) => ({
          sku: i.product.sku, name: i.product.name, quantity: i.quantity, price: i.product.price,
        }));
        if (!items.length) continue;
        const c = await ensureCustomer(draft.customer?.name || msg.customer);
        created.push({
          _id: 'O' + Date.now().toString(36).toUpperCase() + created.length,
          customerId: c._id, customerName: c.name, items,
          total: items.reduce((a, i) => a + i.price * i.quantity, 0),
          status: 'pending', deliveryDate: draft.deliveryDate ?? null,
          createdAt: new Date(), source: 'whatsapp-import', demo: false,
        });
      } catch {
        // Gemma down: skip this line; CSV path still works offline
      }
    }
  }

  if (created.length) await col.orders.insertMany(created);
  return { imported: created.length, csv: !!csvPath, whatsapp: !!whatsappPath };
}

if (import.meta.main) {
  const csvPath = arg('--csv');
  const whatsappPath = arg('--whatsapp');
  if (!csvPath && !whatsappPath) {
    console.error('Usage: import-orders --csv <file> [--whatsapp <file>]');
    process.exit(1);
  }
  await client.connect();
  console.log(await importOrders({ csvPath, whatsappPath }));
  await client.close();
}
