'use strict';
// HTTP-asiakas: välimuisti (5 min), rinnakkaisuusrajoitus (3), aikakatkaisu (15 s),
// 429-käsittely Retry-After-otsakkeella (yksi uusintayritys).

class ApiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;       // NOT_FOUND | RATE_LIMIT | TIMEOUT | NETWORK | HTTP_ERROR | BAD_RESPONSE
    this.status = extra.status || 0;
    this.retryAfter = extra.retryAfter || 0;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
    },
    get active() { return active; },
    get pending() { return queue.length; },
  };
}

function createHttp(opts = {}) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 60000;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || Date.now;
  const onNotice = opts.onNotice || (() => {});
  const limiter = createLimiter(opts.concurrency ?? 3);
  const cache = new Map();    // url -> { at, value } | { at, error }
  const inflight = new Map(); // url -> Promise

  async function fetchOnce(url, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...(headers || {}) } });
    } catch (e) {
      if (e && (e.name === 'AbortError' || ctrl.signal.aborted)) {
        throw new ApiError('TIMEOUT', 'Palvelin ei vastannut ajoissa (15 s).');
      }
      throw new ApiError('NETWORK', 'Verkkovirhe: palvelimeen ei saatu yhteyttä.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(url, headers) {
    let res = await fetchOnce(url, headers);
    if (res.status === 429) {
      const hdr = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      const secs = Number.isFinite(hdr) && hdr > 0 ? hdr : 5;
      if (secs * 1000 > maxRetryWaitMs) {
        throw new ApiError('RATE_LIMIT', `Liikaa pyyntöjä. Yritä uudelleen noin ${Math.ceil(secs)} s kuluttua.`, { status: 429, retryAfter: secs });
      }
      onNotice({ type: 'rate-limit', retryAfter: secs });
      await sleep(secs * 1000);
      res = await fetchOnce(url, headers);
      if (res.status === 429) {
        const h2 = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || secs;
        throw new ApiError('RATE_LIMIT', `Liikaa pyyntöjä. Yritä uudelleen noin ${Math.ceil(h2)} s kuluttua.`, { status: 429, retryAfter: h2 });
      }
    }
    if (res.status === 404) throw new ApiError('NOT_FOUND', 'Ei löytynyt.', { status: 404 });
    if (!res.ok) throw new ApiError('HTTP_ERROR', `Palvelin palautti virheen (${res.status}).`, { status: res.status });
    try {
      return await res.json();
    } catch (_) {
      throw new ApiError('BAD_RESPONSE', 'Palvelimen vastaus oli virheellinen.');
    }
  }

  // o.headers: lisäotsakkeet (esim. api-key); o.noCache: ei muistivälimuistia eikä kutsujen yhdistämistä (kutsuja hallinnoi kutsuja, esim. Arenyze-asiakas).
  function getJson(url, o = {}) {
    if (o.noCache) return limiter.run(() => request(url, o.headers));
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) {
      return hit.error ? Promise.reject(hit.error) : Promise.resolve(hit.value);
    }
    if (inflight.has(url)) return inflight.get(url);
    const p = limiter.run(() => request(url, o.headers)).then(
      (value) => { cache.set(url, { at: now(), value }); return value; },
      (error) => {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') cache.set(url, { at: now(), error });
        throw error;
      },
    ).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  return { getJson, limiter, clearCache: () => cache.clear(), _cache: cache };
}

module.exports = { createHttp, createLimiter, ApiError };
