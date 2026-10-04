// Every request goes through api(): one timeout, one retry for safe requests, one typed error. No DOM, so it is unit-tested.
const API = { base: '/api', timeoutMs: 45_000, longTimeoutMs: 190_000, retries: 1, retryDelayMs: 800 };

/** kind: 'timeout' | 'network' | 'server' (5xx, bad body) | 'request' (4xx). The UI words come from the kind, never from `detail`. */
class ApiError extends Error {
  constructor(kind, { status = 0, detail = '' } = {}) {
    super(detail || kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
  get retryable() { return this.kind === 'network' || this.kind === 'server'; }
}

async function request(path, init, as, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API.base + path, { ...init, signal: ctrl.signal });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new ApiError(r.status >= 500 ? 'server' : 'request', { status: r.status, detail: j.error || r.statusText });
    }
    if (as === 'blob') return await r.blob();
    return await r.json().catch(() => { throw new ApiError('server', { status: r.status, detail: 'Response was not JSON' }); });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(ctrl.signal.aborted ? 'timeout' : 'network', { detail: e.message });
  } finally { clearTimeout(timer); }
}

/**
 * GETs retry once on a network error or 5xx. Writes don't, unless the caller marks them safe to repeat (`retry: true`):
 * a retried "save order" could save it twice.
 */
async function api(path, { method = 'GET', body, as = 'json', retry = method === 'GET', timeoutMs = API.timeoutMs } = {}) {
  const raw = body instanceof Blob;
  const init = body === undefined ? { method } : {
    method,
    headers: { 'content-type': raw ? body.type.split(';')[0] || 'application/octet-stream' : 'application/json' },
    body: raw ? body : JSON.stringify(body),
  };
  for (let attempt = 0; ; attempt++) {
    try { return await request(path, init, as, timeoutMs); }
    catch (e) {
      if (!retry || !e.retryable || attempt >= API.retries) throw e;
      await new Promise(r => setTimeout(r, API.retryDelayMs));
    }
  }
}
