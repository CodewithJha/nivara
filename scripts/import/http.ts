import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UA } from './config.ts';

export async function fetchJson(url: string, { retries = 4, delayMs = 6000 } = {}): Promise<any> {
  let last = '';
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45_000) });
      const text = await r.text();
      last = text.slice(0, 120);
      if (!r.ok || text.trimStart().startsWith('<')) {
        await new Promise(res => setTimeout(res, delayMs * i));
        continue;
      }
      return JSON.parse(text);
    } catch (e: any) {
      last = e.message;
      await new Promise(res => setTimeout(res, delayMs * i));
    }
  }
  throw new Error(`fetchJson failed ${url}: ${last}`);
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function readJson<T>(path: string): T | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null;
}

export function writeCsv(path: string, header: string[], rows: (string | number)[][]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [header.join(','), ...rows.map(r => r.map(c => String(c).includes(',') ? `"${c}"` : c).join(','))].join('\n') + '\n');
}

export function readCsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const [h, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = h.split(',');
  return lines.filter(Boolean).map(line => {
    const cells = line.match(/(".*?"|[^,]+)/g)?.map(c => c.replace(/^"|"$/g, '')) ?? line.split(',');
    const o: Record<string, string> = {};
    cols.forEach((c, i) => (o[c] = cells[i] ?? ''));
    return o;
  });
}
