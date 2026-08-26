const originalFetch = globalThis.fetch;

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const enumFallbackAliases = {
  solucao: new Map([
    ['locacao de switch', 'Cisco'],
    ['locacao switch', 'Cisco'],
    ['locacao de switches', 'Cisco'],
  ]),
};

function fallbackEnumValue(propertyName, suppliedValue) {
  return enumFallbackAliases[propertyName]?.get(normalize(suppliedValue)) || suppliedValue;
}

async function resolveHubSpotEnumValue(url, init, propertyName, suppliedValue) {
  try {
    const parsedUrl = new URL(String(url));
    const base = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const response = await originalFetch(`${base}/crm/v3/properties/deals/${encodeURIComponent(propertyName)}`, {
      method: 'GET',
      headers: init?.headers,
    });
    if (!response.ok) return fallbackEnumValue(propertyName, suppliedValue);
    const definition = await response.json();
    const options = Array.isArray(definition?.options) ? definition.options : [];
    const wanted = normalize(suppliedValue);
    const match = options.find((option) =>
      normalize(option?.value) === wanted || normalize(option?.label) === wanted,
    );
    return match?.value || fallbackEnumValue(propertyName, suppliedValue);
  } catch {
    return fallbackEnumValue(propertyName, suppliedValue);
  }
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(url, init = {}) {
    try {
      const parsedUrl = new URL(String(url));
      const method = String(init?.method || 'GET').toUpperCase();
      const isHubSpotDealCreate = parsedUrl.hostname === 'api.hubapi.com'
        && parsedUrl.pathname === '/crm/v3/objects/deals'
        && method === 'POST';

      if (isHubSpotDealCreate && typeof init?.body === 'string') {
        const payload = JSON.parse(init.body);
        if (payload?.properties?.solucao) {
          const supplied = payload.properties.solucao;
          const resolved = await resolveHubSpotEnumValue(url, init, 'solucao', supplied);
          payload.properties.solucao = resolved;
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
    } catch {
      // Keep the original request unchanged when normalization is not possible.
    }

    return originalFetch(url, init);
  };
}

const preloadFlag = '--import ./hubspot-deal-normalization-preload.js';
const existingNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
if (!existingNodeOptions.includes('hubspot-deal-normalization-preload.js')) {
  process.env.NODE_OPTIONS = [existingNodeOptions, preloadFlag].filter(Boolean).join(' ');
}
