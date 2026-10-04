// Run TabPFN locally and publish per-SKU predictions to Mongo (forecastRuns) for hosts without Python (Render).
// Usage: npm run forecast:publish [-- --top=N --chunk=N]   (MONGODB_URI decides where it lands; FORECAST_TOP_N / FORECAST_CHUNK)
import { client } from '../src/db.ts';
import { publishForecastRun } from '../src/ops.ts';

const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const top = Number(flag('top') ?? process.env.FORECAST_TOP_N ?? 0) || undefined;
const chunk = Number(flag('chunk') ?? process.env.FORECAST_CHUNK ?? 0) || undefined;

await client.connect();
try {
  console.log(JSON.stringify(await publishForecastRun({ top, chunk }), null, 1));
} finally {
  await client.close();
}
