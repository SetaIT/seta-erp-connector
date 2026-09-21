const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const disabled = (value) => ['disabled', 'off', 'false', '0', 'readonly', 'read-only'].includes(String(value || '').trim().toLowerCase());

function hostname(value) {
  try { return value ? new URL(value).hostname.toLowerCase() : ''; }
  catch { return ''; }
}

function requestDetails(input, init = {}) {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  let url;
  try { url = new URL(rawUrl); }
  catch { return { method, url: null }; }
  return { method, url };
}

export function shouldBlockExternalWrite({ input, init = {}, env = process.env }) {
  if (truthy(env.ALLOW_PRODUCTION_WRITES)) return null;

  const { method, url } = requestDetails(input, init);
  if (!url || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;

  const host = url.hostname.toLowerCase();
  const local = host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.railway.internal');
  if (local) return null;

  const betelHost = hostname(env.BETEL_BASE_URL);
  const hubspotHost = hostname(env.HUBSPOT_BASE_URL || 'https://api.hubapi.com');

  if (disabled(env.ERP_WRITE_MODE) && betelHost && host === betelHost) {
    return { system: 'erp', method, url: url.toString() };
  }

  if (disabled(env.HUBSPOT_WRITE_MODE) && hubspotHost && host === hubspotHost) {
    const readOnlySearch = method === 'POST' && /\/search\/?$/i.test(url.pathname);
    if (!readOnlySearch) return { system: 'hubspot', method, url: url.toString() };
  }

  if (disabled(env.EMAIL_SEND_MODE) && host === 'graph.microsoft.com' && /\/sendMail\/?$/i.test(url.pathname)) {
    return { system: 'outlook', method, url: url.toString() };
  }

  return null;
}

export function installEnvironmentWriteGuard(env = process.env) {
  if (typeof globalThis.fetch !== 'function') return false;
  if (globalThis.__setaEnvironmentWriteGuardInstalled) return false;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const blocked = shouldBlockExternalWrite({ input, init, env });
    if (blocked) {
      const error = new Error(`External write blocked by environment guard: ${blocked.system} ${blocked.method}`);
      error.code = 'WRITE_GUARD_BLOCKED';
      error.system = blocked.system;
      error.method = blocked.method;
      error.url = blocked.url;
      throw error;
    }
    return originalFetch(input, init);
  };

  globalThis.__setaEnvironmentWriteGuardInstalled = true;
  console.log(JSON.stringify({
    event: 'environment_write_guard_installed',
    environment_guard: env.ENVIRONMENT_GUARD || null,
    allow_production_writes: truthy(env.ALLOW_PRODUCTION_WRITES),
    erp_write_mode: env.ERP_WRITE_MODE || null,
    hubspot_write_mode: env.HUBSPOT_WRITE_MODE || null,
    email_send_mode: env.EMAIL_SEND_MODE || null,
  }));
  return true;
}

installEnvironmentWriteGuard();
