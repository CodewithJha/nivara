import { proxyActivities, log } from '@temporalio/workflow';
import type * as acts from './activities.ts';

const a = proxyActivities<typeof acts>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 },
});

/** Forecast once, then the steps that only read it in parallel. The brief doesn't use live prices. */
export async function dailyBriefWorkflow() {
  const forecast = await a.forecast();
  const [lowStockCheck, supplierRefresh, dailyBrief] = await Promise.all([
    a.lowStockCheck(),
    a.supplierRefresh().catch((e: any) => { log.warn('supplier refresh exhausted retries; brief continues without it', { err: e.message }); return { error: e.message }; }),
    a.dailyBrief(),
  ]);
  return { forecast, lowStockCheck, supplierRefresh, dailyBrief };
}
export const lowStockWorkflow = () => a.lowStockCheck();
export const forecastWorkflow = () => a.forecast();
export const supplierRefreshWorkflow = () => a.supplierRefresh();
