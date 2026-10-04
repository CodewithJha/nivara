#!/usr/bin/env node
// Stand-in for forecast/.venv/bin/python in tests: same stdin/stdout contract as forecast/forecast.py
// (prediction = last 7 days summed). Records each call's SKU count in FAKE_TABPFN_LOG.
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', d => (input += d)).on('end', () => {
  const series = JSON.parse(input);
  if (process.env.FAKE_TABPFN_LOG) appendFileSync(process.env.FAKE_TABPFN_LOG, Object.keys(series).length + '\n');
  const pred = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.slice(-7).reduce((a, b) => a + b, 0)]));
  process.stdout.write(JSON.stringify({ model: 'stub', package: 'tabpfn fake', pred }));
});
