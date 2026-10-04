import { Context } from '@temporalio/activity';
import * as ops from '../ops.ts';
import { traced } from '../integrations.ts';

const attemptNo = () => { try { return Context.current().info.attempt; } catch { return 1; } };

export const lowStockCheck = () => traced('activity.lowStockCheck', {}, async () => {
  const inv = await ops.getInventory();
  return { method: inv.method, lowStock: inv.lowStock.map((i: any) => ({ name: i.name, risk: i.risk, reorderQty: i.reorderQty })) };
});
export const forecast = () => traced('activity.forecast', {}, async () => {
  const f = await ops.forecastDemand({ force: true });
  return { method: f.method, fallbackReason: f.fallbackReason, highRisk: f.items.filter((i: any) => i.risk === 'high').length };
});
export const supplierRefresh = (attempt = attemptNo()) => traced('activity.supplierRefresh', { attempt }, () => ops.supplierPriceRefresh(attempt));
export const dailyBrief = () => traced('activity.dailyBrief', {}, async () => {
  const b = await ops.generateDailyBrief();
  return { date: b.date, by: b.by, text: b.text };
});
