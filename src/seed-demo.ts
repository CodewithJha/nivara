// Reproducible demo data (seeded RNG, dates relative to today). Every doc has demo: true.
import { client, col, daysAgo, today, type Order, type Product, type Sale } from './db.ts';

let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const poisson = (l: number) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };

// [sku, name, aliases, category, price, cost, stock, supplier, leadTime, base daily demand]
const P: [string, string, string[], string, number, number, number, string, number, number][] = [
  ['P01', 'Chocolate Protein Bar', ['choco bar', 'chocolate bar', 'protein bar'], 'bars', 90, 52, 18, 'S1', 4, 4.5],
  ['P02', 'Peanut Butter Protein Bar', ['pb bar', 'peanut bar'], 'bars', 95, 55, 46, 'S1', 4, 3.2],
  ['P03', 'Cookies & Cream Protein Bar', ['cookie bar', 'cookies cream bar'], 'bars', 95, 56, 9, 'S2', 5, 2.4],
  ['P04', 'Whey Protein 1kg Chocolate', ['whey', 'whey chocolate', 'protein powder'], 'powder', 2499, 1780, 7, 'S3', 6, 0.9],
  ['P05', 'Shaker Bottle 700ml', ['shaker', 'shaker bottle', 'bottle'], 'accessories', 299, 120, 12, 'S2', 3, 1.6],
  ['P06', 'Creatine Monohydrate 250g', ['creatine'], 'powder', 899, 560, 22, 'S3', 6, 0.8],
  ['P07', 'Resistance Band Set', ['bands', 'resistance band'], 'accessories', 649, 310, 15, 'S4', 7, 0.5],
  ['P08', 'Gym Gloves', ['gloves'], 'accessories', 399, 170, 4, 'S4', 7, 0.6],
  ['P09', 'Peanut Butter 1kg Crunchy', ['peanut butter', 'pb jar'], 'food', 449, 290, 30, 'S1', 4, 1.3],
  ['P10', 'BCAA 300g Watermelon', ['bcaa'], 'powder', 1199, 780, 10, 'S3', 6, 0.4],
  ['P11', 'Oats 1kg Rolled', ['oats'], 'food', 199, 110, 40, 'S1', 3, 1.9],
  ['P12', 'Pre-Workout 300g Fruit Punch', ['pre workout', 'preworkout'], 'powder', 1499, 980, 3, 'S3', 6, 0.5],
  ['P13', 'Steel Water Bottle 1L', ['steel bottle', 'water bottle'], 'accessories', 549, 260, 25, 'S2', 3, 0.7],
  ['P14', 'Mass Gainer 3kg', ['gainer', 'mass gainer'], 'powder', 2999, 2150, 5, 'S3', 6, 0.3],
];
const customers = ['Rahul Verma', 'Priya Singh', 'Aman Khan', 'Sneha Gupta', 'Vikram Rao', 'Neha Sharma', 'Arjun Mehta', 'Kavya Iyer']
  .map((name, i) => ({ _id: `C0${i + 1}`, name, channel: (i % 3 ? 'whatsapp' : 'instagram') as 'whatsapp' | 'instagram', demo: true }));
const suppliers = [
  { _id: 'S1', name: 'FitFuel Distributors', contact: 'Lucknow wholesale market' },
  { _id: 'S2', name: 'GymGear Wholesale', contact: 'Delhi, ships in 3 days' },
  { _id: 'S3', name: 'NutriHub India', contact: 'Authorised supplements distributor' },
  { _id: 'S4', name: 'Supplier C (Sports Mart)', contact: 'Kanpur, cheap but delays' },
];

export async function seedDemo() {
  const t = today();
  const products: Product[] = P.map(([_id, name, aliases, category, price, cost, stock, supplierId, leadTimeDays]) => ({ _id, name, aliases, category, price, cost, stock, supplierId, leadTimeDays, demo: true }));
  // 90 days of daily sales: base demand × weekend bump × mild upward trend
  const sales: Sale[] = [];
  for (let d = 90; d >= 1; d--) {
    const date = daysAgo(d, t), dow = new Date(date).getUTCDay();
    for (const p of P) sales.push({ sku: p[0], date, qty: poisson(p[9] * (dow === 0 || dow === 6 ? 1.35 : 1) * (1 + (90 - d) / 300)), demo: true });
  }
  const priced = (sku: string, mult: number) => ({ sku, unitCost: Math.round(P.find(p => p[0] === sku)![5] * mult) });
  const sup = suppliers.map(x => ({ ...x, demo: true, quotes: P.filter(() => rnd() < 0.6).map(p => priced(p[0], x._id === 'S4' ? 0.82 : 0.9 + rnd() * 0.2)) }));
  const mk = (i: number, c: number, items: [number, number][], status: Order['status'], delivery: number, created: number): Order => {
    const its = items.map(([pi, q]) => ({ sku: P[pi][0], name: P[pi][1], quantity: q, price: P[pi][4] }));
    return { _id: `O${String(i).padStart(3, '0')}`, customerId: customers[c]._id, customerName: customers[c].name, items: its, total: its.reduce((a, b) => a + b.price * b.quantity, 0), status, deliveryDate: daysAgo(-delivery, t), createdAt: new Date(Date.parse(daysAgo(created, t)) + 11 * 36e5), source: 'demo-seed', demo: true };
  };
  const orders = [
    mk(1, 0, [[0, 3], [4, 1]], 'pending', 1, 0),
    mk(2, 1, [[3, 1]], 'pending', 0, 1),
    mk(3, 2, [[2, 4], [1, 2]], 'pending', 2, 0),
    mk(4, 3, [[11, 1], [7, 1]], 'pending', -1, 3),
    mk(5, 5, [[0, 6]], 'pending', 3, 0),
    mk(6, 4, [[5, 1], [10, 2]], 'delivered', -1, 2),
    mk(7, 6, [[13, 1]], 'delivered', -2, 4),
    mk(8, 7, [[12, 1], [4, 2]], 'delivered', -3, 5),
    mk(9, 0, [[8, 2], [10, 1]], 'delivered', -5, 7),
  ];
  for (const c of Object.values(col)) if (!['traces', 'meta'].includes(c.collectionName)) await c.deleteMany({});
  await col.products.insertMany(products);
  await col.customers.insertMany(customers);
  await col.suppliers.insertMany(sup);
  await col.sales.insertMany(sales);
  await col.orders.insertMany(orders);
  await col.preferences.insertOne({ text: 'Prefer suppliers that deliver within 5 days.', kind: 'note', createdAt: new Date(), mirror: 'local-only', demo: true } as any);
  await col.sales.createIndex({ sku: 1, date: 1 });
  return { products: products.length, customers: customers.length, suppliers: sup.length, sales: sales.length, orders: orders.length };
}

if (import.meta.main) {
  await client.connect();
  console.log('seeded demo', await seedDemo());
  await client.close();
}
