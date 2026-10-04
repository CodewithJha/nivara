import { proxyActivities, log } from '@temporalio/workflow';
import type * as acts from './activities.ts';

const a = proxyActivities<typeof acts>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 },
});

export async function dailyBriefWorkflow() {
  const lowStock = await a.lowStockCheck();
  const forecast = await a.forecast();
  let suppliers;
  try { suppliers = await a.supplierRefresh(); }
  catch (e: any) { log.warn('supplier refresh exhausted retries; brief continues without it', { err: e.message }); suppliers = { error: e.message }; }
  const brief = await a.dailyBrief();
  return { lowStock, forecast, suppliers, brief };
}
export const lowStockWorkflow = () => a.lowStockCheck();
export const forecastWorkflow = () => a.forecast();
export const supplierRefreshWorkflow = () => a.supplierRefresh();
