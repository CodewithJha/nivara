import { fileURLToPath } from 'node:url';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { client as mongo } from '../db.ts';
import { log } from '../integrations.ts';
import * as activities from './activities.ts';

export const TASK_QUEUE = 'nivara';
const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

const cloud = process.env.TEMPORAL_API_KEY ? { tls: true, apiKey: process.env.TEMPORAL_API_KEY } : {};

await mongo.connect();
const connection = await NativeConnection.connect({ address, ...cloud });

// Daily brief at 08:00 business time. Idempotent: an existing schedule is left alone.
const sc = new Client({ connection: await Connection.connect({ address, ...cloud }), namespace }).schedule;
try {
  await sc.create({
    scheduleId: 'daily-brief',
    spec: { cronExpressions: [process.env.BRIEF_CRON ?? '0 8 * * *'], timezone: process.env.BUSINESS_TZ ?? 'Asia/Kolkata' },
    action: { type: 'startWorkflow', workflowType: 'dailyBriefWorkflow', taskQueue: TASK_QUEUE, args: [] },
    policies: { overlap: ScheduleOverlapPolicy.SKIP },
  });
  log.info('created Temporal schedule daily-brief');
} catch (e: any) { log.info({ msg: e.message }, 'schedule daily-brief already exists or could not be created'); }

const worker = await Worker.create({ connection, namespace, taskQueue: TASK_QUEUE, workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)), activities });
log.info({ address, taskQueue: TASK_QUEUE }, 'Temporal worker running');
await worker.run(); // resolves after SIGTERM/SIGINT once in-flight activities finish
await mongo.close();
await connection.close();
