import { MongoClient } from 'mongodb';

export type Product = { _id: string; name: string; aliases: string[]; category: string; price: number; cost: number; stock: number; supplierId: string; leadTimeDays: number; demo?: boolean };
export type Customer = { _id: string; name: string; phone?: string; channel: 'whatsapp' | 'instagram'; demo?: boolean };
export type Order = { _id: string; customerId: string; customerName: string; items: { sku: string; name: string; quantity: number; price: number }[]; total: number; status: 'pending' | 'delivered' | 'cancelled'; deliveryDate: string | null; createdAt: Date; source: string; demo?: boolean };
export type Sale = { sku: string; date: string; qty: number; demo?: boolean };
export type Supplier = { _id: string; name: string; contact?: string; quotes: { sku: string; unitCost: number }[]; demo?: boolean };
export type Preference = { _id?: any; text: string; kind: 'block_supplier' | 'note'; supplier?: string; createdAt: Date; mirror: 'backboard' | 'local-only'; backboardId?: string };

export const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017', { serverSelectionTimeoutMS: 5000 });
const db = client.db(process.env.MONGODB_DB ?? 'nivara');

export const col = {
  products: db.collection<Product>('products'),
  customers: db.collection<Customer>('customers'),
  orders: db.collection<Order>('orders'),
  sales: db.collection<Sale>('sales'),
  suppliers: db.collection<Supplier>('suppliers'),
  preferences: db.collection<Preference>('preferences'),
  forecasts: db.collection<any>('forecasts'),
  briefs: db.collection<any>('briefs'),
  traces: db.collection<any>('traces'),
  meta: db.collection<{ _id: string; value: any }>('meta'),
  supplierPrices: db.collection<any>('supplierPrices'), // latest live (SerpApi) result per SKU, written only by the Temporal refresh

};

export const TZ = process.env.BUSINESS_TZ ?? 'Asia/Kolkata';
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const daysAgo = (n: number, from = today()) => new Date(Date.parse(from + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
