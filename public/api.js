// Every request goes through api(): one timeout, one retry for safe requests, one typed error. No DOM, so it is unit-tested.
const API = { base: '/api', timeoutMs: 45_000, longTimeoutMs: 190_000, retries: 1, retryDelayMs: 800 };
const OOPS = {
  offline: "You're offline. Check your connection, then try again.",
  timeout: 'This is taking longer than usual. Try again in a moment.',
  network: "Can't reach Nivara right now. Check your connection, then try again.",
  server: 'Something went wrong on our side. Try again in a moment.',
  request: "That didn't work. Check it and try again.",
};

/**
 * kind: 'offline' | 'timeout' | 'network' | 'server' (5xx, bad body) | 'request' (4xx).
 * The UI words come from the kind, or from `userMessage` (the server's friendly { error: { message } }); never from `detail`.
 */
class ApiError extends Error {
  constructor(kind, { status = 0, detail = '', code = '', userMessage = '' } = {}) {
    super(detail || kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.userMessage = userMessage;
  }
  get retryable() { return this.kind === 'network' || this.kind === 'server'; }
  /** Plain words for the owner. */
  get friendly() { return (this.kind === 'request' || this.kind === 'server') && this.userMessage ? this.userMessage : OOPS[this.kind] ?? OOPS.server; }
}

async function request(path, init, as, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API.base + path, { ...init, signal: ctrl.signal });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const env = j && typeof j.error === 'object' && j.error ? j.error : {};
      throw new ApiError(r.status >= 500 ? 'server' : 'request', { status: r.status, detail: env.code || (typeof j.error === 'string' ? j.error : r.statusText), code: env.code || '', userMessage: typeof env.message === 'string' ? env.message : '' });
    }
    if (as === 'blob') return await r.blob();
    return await r.json().catch(() => { throw new ApiError('server', { status: r.status, detail: 'Response was not JSON' }); });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new ApiError(ctrl.signal.aborted ? 'timeout' : offline ? 'offline' : 'network', { detail: e.message });
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
