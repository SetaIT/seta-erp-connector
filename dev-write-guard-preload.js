const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const developmentMode = truthy(process.env.DEV_MODE)
  || String(process.env.APP_ENV || '').toLowerCase() === 'development'
  || String(process.env.NODE_ENV || '').toLowerCase() === 'development';
const productionWritesAllowed = truthy(process.env.ALLOW_PRODUCTION_WRITES);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  return null;
}

function isInternalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.railway.internal');
}

if (developmentMode && !productionWritesAllowed && typeof globalThis.fetch === 'function' && !globalThis.__SETA_DEV_WRITE_GUARD__) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.__SETA_DEV_WRITE_GUARD__ = { installed: true, originalFetch };

  globalThis.fetch = async (input, init = {}) => {
    const method = requestMethod(input, init);
    if (safeMethods.has(method)) return originalFetch(input, init);

    const url = requestUrl(input);
    if (url && isInternalHost(url.hostname)) return originalFetch(input, init);

    const target = url ? `${url.protocol}//${url.host}${url.pathname}` : 'unknown-target';
    const error = new Error(`DEV_WRITE_BLOCKED: ${method} ${target}`);
    error.code = 'DEV_WRITE_BLOCKED';
    error.status = 423;
    error.method = method;
    error.target = target;

    console.warn(JSON.stringify({
      event: 'dev_write_blocked',
      method,
      target,
      app_env: process.env.APP_ENV || process.env.NODE_ENV || 'development'
    }));

    throw error;
  };

  console.warn('DEV outbound write guard enabled: external POST/PUT/PATCH/DELETE requests are blocked.');
}
