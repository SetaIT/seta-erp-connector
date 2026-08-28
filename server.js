import express from 'express';
import fs from 'fs';
import {
  EFFECTIVE_STATUS,
  ERROR_TAXONOMY,
  correlationIdFrom,
  reconcileWrite,
  resolveEnumOption,
  sanitizePayload,
  structuredLog,
} from './commercial-write-reconciliation.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.correlationId = correlationIdFrom(req.headers['x-correlation-id']);
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

const PORT = process.env.PORT || 3000;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const PUBLIC_PROPOSAL_BASE_URL = process.env.PUBLIC_PROPOSAL_BASE_URL || 'https://app.setatelecom.com.br/prop';

function getMissingEnv() {
  const missing = [];
  if (!BETEL_ACCESS_TOKEN) missing.push('BETEL_ACCESS_TOKEN');
  if (!BETEL_SECRET_ACCESS_TOKEN) missing.push('BETEL_SECRET_ACCESS_TOKEN');
  if (!CONNECTOR_API_KEY) missing.push('CONNECTOR_API_KEY');
  return missing;
}

const missingAtStartup = getMissingEnv();
if (missingAtStartup.length) console.warn(`Connector started with missing environment variables: ${missingAtStartup.join(', ')}`);

function auth(req, res, next) {
  const missing = getMissingEnv();
  if (missing.length) return res.status(503).json({ error: 'connector_not_configured', missing });
  if (req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function cleanQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') params.append(key, String(value));
  }
  return params.toString();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function betelRequest(path, { method = 'GET', query, body, correlationId, operation, observe = false } = {}) {
  const qs = cleanQuery(query);
  const url = `${BETEL_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  const maxAttempts = method === 'GET' ? 2 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'access-token': BETEL_ACCESS_TOKEN,
          'secret-access-token': BETEL_SECRET_ACCESS_TOKEN,
          Accept: 'application/json',
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      const requestId = response.headers.get('x-request-id')
        || response.headers.get('x-correlation-id')
        || response.headers.get('cf-ray');
      if (response.ok) return observe ? { http_status: response.status, data, request_id: requestId } : data;

      const err = new Error(`Betel API error ${response.status}`);
      err.status = response.status;
      err.data = data;
      err.source = 'betel';
      err.endpoint = path;
      err.operation = operation || `${method.toLowerCase()}_betel`;
      err.correlation_id = correlationId;
      err.request_id = requestId;
      err.payload = sanitizePayload(body);
      err.timestamp = new Date().toISOString();
      lastError = err;
      if (method === 'GET' && response.status >= 500 && attempt < maxAttempts) {
        await sleep(400);
        continue;
      }
      throw err;
    } catch (err) {
      err.endpoint ??= path;
      err.operation ??= operation || `${method.toLowerCase()}_betel`;
      err.correlation_id ??= correlationId;
      err.payload ??= sanitizePayload(body);
      err.timestamp ??= new Date().toISOString();
      lastError = err;
      if (method === 'GET' && !err.status && attempt < maxAttempts) {
        await sleep(400);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function hubspotRequest(path, { method = 'GET', body, correlationId, operation, observe = false } = {}) {
  if (!HUBSPOT_ACCESS_TOKEN) {
    const err = new Error('HUBSPOT_ACCESS_TOKEN nao configurado');
    err.status = 503;
    err.source = 'hubspot';
    err.data = { missing: ['HUBSPOT_ACCESS_TOKEN'] };
    throw err;
  }

  const response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      Accept: 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  const requestId = response.headers.get('x-request-id')
    || response.headers.get('x-correlation-id')
    || response.headers.get('cf-ray');
  if (response.ok) return observe ? { http_status: response.status, data, request_id: requestId } : data;

  const err = new Error(`HubSpot API error ${response.status}`);
  err.status = response.status;
  err.data = data;
  err.source = 'hubspot';
  err.endpoint = path;
  err.operation = operation || `${method.toLowerCase()}_hubspot`;
  err.correlation_id = correlationId;
  err.request_id = requestId;
  err.payload = sanitizePayload(body);
  err.timestamp = new Date().toISOString();
  throw err;
}

function handleError(err, res) {
  console.error(err);
  if (err.status) {
    return res.status(err.status).json({
      error: `${err.source || 'request'}_error`,
      status: err.status,
      message: err.message,
      details: sanitizePayload(err.data),
      error_taxonomy: err.taxonomy || (err.source === 'request' ? ERROR_TAXONOMY.VALIDATION_ERROR : null),
      endpoint: err.endpoint || null,
      operation: err.operation || null,
      request_correlation_id: err.correlation_id || null,
      downstream_request_id: err.request_id || null,
      sanitized_payload: sanitizePayload(err.payload || null),
      timestamp: err.timestamp || new Date().toISOString()
    });
  }
  return res.status(500).json({ error: 'connector_error', message: err.message });
}

function loadJsonFile(name) {
  const fileUrl = new URL(`./${name}`, import.meta.url);
  return JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
}
function loadBillingRules() { return loadJsonFile('billing-rules.json'); }
function loadProposalRules() { return loadJsonFile('proposal-rules.json'); }

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function findBillingRule({ cliente, cliente_id }) {
  const rules = loadBillingRules().clients || [];
  const normalizedClient = normalizeText(cliente);
  return rules.find(rule => {
    if (!rule.ativo) return false;
    if (cliente_id && rule.cliente_erp_id && String(rule.cliente_erp_id) === String(cliente_id)) return true;
    const names = [rule.cliente_nome, ...(rule.aliases || [])].map(normalizeText);
    return normalizedClient && names.some(name => name === normalizedClient || normalizedClient.includes(name) || name.includes(normalizedClient));
  });
}

function requestError(message, details = {}) {
  const err = new Error(message);
  err.status = 400;
  err.data = details;
  err.source = 'request';
  return err;
}

function parseMoney(value, fieldName) {
  if (value === undefined || value === null || value === '') return 0;
  let normalized = String(value).trim().replace(/\s/g, '').replace(/R\$|US\$/gi, '');
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (normalized.includes(',')) normalized = normalized.replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw requestError(`${fieldName} deve ser numerico`, { field: fieldName, value });
  return parsed;
}

function proposalTotal(products) {
  if (!Array.isArray(products) || products.length === 0) throw requestError('produtos deve conter pelo menos um item', { field: 'produtos' });
  return products.reduce((total, item, index) => {
    const product = item?.produto || {};
    const quantity = parseMoney(product.quantidade ?? 1, `produtos[${index}].produto.quantidade`);
    const unitPrice = parseMoney(product.valor_venda, `produtos[${index}].produto.valor_venda`);
    return total + quantity * unitPrice;
  }, 0);
}

function formatProposalMoney(value, currency) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency === 'USD' ? 'USD' : 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number).replace(/\u00a0/g, ' ');
}

function getProposalTypeRule(typeKey) {
  const rules = loadProposalRules();
  const normalized = normalizeText(typeKey);
  const typeRule = rules.types?.[normalized];
  if (!typeRule) throw requestError('tipo_proposta invalido', { field: 'tipo_proposta', allowed: Object.keys(rules.types || {}) });
  return { rules, typeKey: normalized, typeRule };
}

function requiredText(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw requestError(`${fieldName} e obrigatorio para este tipo de proposta`, { field: fieldName });
  return normalized;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw requestError(`${fieldName} deve ser um inteiro maior que zero`, { field: fieldName, value });
  return parsed;
}

function parseIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw requestError(`${fieldName} deve estar no formato YYYY-MM-DD`, { field: fieldName, expected_format: 'YYYY-MM-DD' });
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw requestError(`${fieldName} invalida`, { field: fieldName });
  return date;
}
function formatIsoDate(date) { return date.toISOString().slice(0, 10); }
function formatDmyDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}
function addDaysUtc(date, days) { const result = new Date(date.getTime()); result.setUTCDate(result.getUTCDate() + days); return result; }
function nextWednesdayOnOrAfter(date) { return addDaysUtc(date, (3 - date.getUTCDay() + 7) % 7); }

function extractProposalData(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') return result.data;
  return result && typeof result === 'object' ? result : null;
}

function collectionFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'results', 'items', 'orcamentos', 'registros']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function findProposalByCommercialNumber(payload, numero) {
  const target = String(numero);
  const candidates = collectionFromPayload(payload);
  const match = candidates.find((item) =>
    String(item?.codigo ?? item?.numero ?? item?.numero_proposta ?? item?.codigo_orcamento ?? '') === target,
  );
  if (match) return match;
  const single = extractProposalData(payload);
  if (single && !Array.isArray(single)) {
    const candidate = single.codigo ?? single.numero ?? single.numero_proposta ?? single.codigo_orcamento;
    if (String(candidate ?? '') === target) return single;
  }
  return null;
}

function normalizeComparable(value) {
  if (value === undefined || value === null) return '';
  const numeric = Number(String(value).replace(',', '.'));
  return Number.isFinite(numeric) ? String(numeric) : String(value).trim().toLowerCase();
}

function proposalEquivalence(actual, expected) {
  const mismatches = [];
  const compare = (field, actualValue, expectedValue) => {
    if (actualValue === undefined || actualValue === null || expectedValue === undefined || expectedValue === null) return;
    if (normalizeComparable(actualValue) !== normalizeComparable(expectedValue)) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue });
    }
  };
  compare('codigo', actual?.codigo ?? actual?.numero, expected?.codigo);
  compare('cliente_id', actual?.cliente_id, expected?.cliente_id);
  compare('tipo', actual?.tipo, expected?.tipo);

  const actualProducts = Array.isArray(actual?.produtos) ? actual.produtos : [];
  const expectedProducts = Array.isArray(expected?.produtos) ? expected.produtos : [];
  if (actualProducts.length && expectedProducts.length) {
    if (actualProducts.length !== expectedProducts.length) {
      mismatches.push({ field: 'produtos.length', expected: expectedProducts.length, actual: actualProducts.length });
    } else {
      expectedProducts.forEach((entry, index) => {
        const expectedProduct = entry?.produto || entry;
        const actualProduct = actualProducts[index]?.produto || actualProducts[index] || {};
        compare(`produtos[${index}].id`, actualProduct.id ?? actualProduct.produto_id, expectedProduct.id);
        compare(`produtos[${index}].variacao_id`, actualProduct.variacao_id, expectedProduct.variacao_id);
        compare(`produtos[${index}].quantidade`, actualProduct.quantidade, expectedProduct.quantidade);
        compare(`produtos[${index}].valor_venda`, actualProduct.valor_venda, expectedProduct.valor_venda);
      });
    }
  }
  return { equivalent: mismatches.length === 0, mismatches };
}

async function verifyProposalWrite(numero, expected, correlationId) {
  try {
    const search = await betelRequest('/orcamentos', {
      query: { codigo: numero },
      correlationId,
      operation: 'verify_proposal_by_commercial_number',
    });
    const summary = findProposalByCommercialNumber(search, numero);
    if (!summary) return { outcome: 'absent', details: { numero, search: sanitizePayload(search) } };

    const internalId = summary.id ?? summary.orcamento_id ?? summary.id_orcamento;
    let resource = summary;
    if (internalId) {
      try {
        const detail = await betelRequest(`/orcamentos/${encodeURIComponent(internalId)}`, {
          correlationId,
          operation: 'verify_proposal_detail',
        });
        resource = extractProposalData(detail) || summary;
      } catch (error) {
        return {
          outcome: 'inconclusive',
          details: {
            numero,
            found_summary: sanitizePayload(summary),
            detail_error: error instanceof Error ? error.message : 'proposal_detail_failed',
          },
        };
      }
    }

    const comparison = proposalEquivalence(resource, expected);
    return {
      outcome: 'found',
      equivalent: comparison.equivalent,
      resource,
      details: { numero, mismatches: comparison.mismatches },
    };
  } catch (error) {
    return {
      outcome: 'inconclusive',
      details: {
        numero,
        message: error instanceof Error ? error.message : 'proposal_verification_failed',
        http_status: error?.status ?? null,
        downstream_response: sanitizePayload(error?.data ?? null),
      },
    };
  }
}

function buildPublicProposalLink(hash) {
  const normalizedHash = String(hash || '').trim();
  if (!normalizedHash) return null;
  return `${PUBLIC_PROPOSAL_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(normalizedHash)}`;
}

async function resolvePublicProposalLink(result) {
  let source = extractProposalData(result);
  let internalId = source?.id ? String(source.id) : null;
  let hash = source?.hash ? String(source.hash).trim() : '';
  let lookupPerformed = false;
  let lookupError = null;

  if (!hash && internalId) {
    lookupPerformed = true;
    try {
      const refreshed = await betelRequest(`/orcamentos/${encodeURIComponent(internalId)}`);
      const refreshedData = extractProposalData(refreshed);
      source = refreshedData || source;
      hash = refreshedData?.hash ? String(refreshedData.hash).trim() : '';
      internalId = refreshedData?.id ? String(refreshedData.id) : internalId;
    } catch (err) {
      lookupError = err.message;
    }
  }

  const link = buildPublicProposalLink(hash);
  return {
    link_proposta: link,
    link_proposta_status: link ? 'validated_from_erp_hash' : 'unavailable',
    link_proposta_hash: hash || null,
    link_proposta_orcamento_id: internalId,
    link_proposta_lookup_performed: lookupPerformed,
    link_proposta_lookup_error: lookupError
  };
}

const EDITABLE_PROPOSAL_FIELDS = [
  'data',
  'validade',
  'situacao_id',
  'vendedor_id',
  'previsao_entrega',
  'prazo_entrega',
  'valor_frete',
  'introducao',
  'observacoes',
  'observacoes_interna'
];

function currentProposalRequiredField(current, field) {
  const value = current?.[field];
  if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  if (field === 'tipo') return 'produto';
  throw requestError(`Nao foi possivel preservar o campo obrigatorio ${field} da proposta atual`, { field, available_fields: Object.keys(current || {}) });
}

function buildProposalEditPayload(current, body) {
  if (body.confirmacao_edicao !== true) throw requestError('confirmacao_edicao deve ser true antes de editar a proposta', { field: 'confirmacao_edicao' });

  const changes = {};
  for (const field of EDITABLE_PROPOSAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) changes[field] = body[field];
  }
  if (Object.keys(changes).length === 0) throw requestError('Informe pelo menos um campo para alterar', { allowed_fields: EDITABLE_PROPOSAL_FIELDS });

  if (Object.prototype.hasOwnProperty.call(changes, 'data')) parseIsoDate(changes.data, 'data');

  const payload = {
    tipo: currentProposalRequiredField(current, 'tipo'),
    codigo: currentProposalRequiredField(current, 'codigo'),
    cliente_id: currentProposalRequiredField(current, 'cliente_id'),
    situacao_id: currentProposalRequiredField(current, 'situacao_id'),
    data: currentProposalRequiredField(current, 'data'),
    ...changes
  };

  return { payload, changes };
}

function buildProposalIntroduction(body) {
  const { rules, typeKey, typeRule } = getProposalTypeRule(body.tipo_proposta);
  const solution = String(body.solucao || '').trim();
  if (!solution) throw requestError('solucao e obrigatoria', { field: 'solucao' });

  let months = null;
  if (typeRule.requires_months) {
    months = Number(body.meses);
    if (!Number.isInteger(months) || months <= 0) throw requestError('meses deve ser um inteiro maior que zero para este tipo de proposta', { field: 'meses' });
  }

  const currency = String(body.moeda || rules.currency_default || 'BRL').trim().toUpperCase();
  if (!['BRL', 'USD'].includes(currency)) throw requestError('moeda invalida', { field: 'moeda', allowed: ['BRL', 'USD'] });

  const total = proposalTotal(body.produtos);
  const formattedValue = formatProposalMoney(total, currency);
  const pattern = typeKey === 'compra'
    ? (currency === 'USD' ? typeRule.introduction_pattern_usd : typeRule.introduction_pattern_brl)
    : typeRule.introduction_pattern;

  let deliveryDays = null;
  let deliveryTerm = '';
  let deliveryDate = null;
  if (typeRule.requires_delivery_term) {
    deliveryDays = parsePositiveInteger(body.prazo_entrega_dias, 'prazo_entrega_dias');
    const proposalDate = parseIsoDate(body.data, 'data');
    deliveryDate = formatDmyDate(addDaysUtc(proposalDate, deliveryDays));
    deliveryTerm = `${deliveryDays} dias`;
  }

  const sla = typeRule.requires_sla ? requiredText(body.sla, 'sla') : String(body.sla || '').trim();

  let freightFormatted = '';
  if (typeRule.requires_freight) {
    if (body.valor_frete === undefined || body.valor_frete === null || String(body.valor_frete).trim() === '') {
      throw requestError('valor_frete e obrigatorio para este tipo de proposta, inclusive quando for zero', { field: 'valor_frete' });
    }
    freightFormatted = formatProposalMoney(parseMoney(body.valor_frete, 'valor_frete'), currency);
  } else if (body.valor_frete !== undefined && body.valor_frete !== null && String(body.valor_frete).trim() !== '') {
    freightFormatted = formatProposalMoney(parseMoney(body.valor_frete, 'valor_frete'), currency);
  }

  const variableBlock = String(pattern || typeRule.label)
    .replaceAll('{meses}', String(months ?? ''))
    .replaceAll('{valor_formatado}', formattedValue)
    .replaceAll('{prazo_entrega}', deliveryTerm)
    .replaceAll('{frete_formatado}', freightFormatted)
    .replaceAll('{sla}', sla)
    .trim();

  const fixedFooter = String(rules.introduction?.fixed_footer || '').trim();
  const introduction = [variableBlock, fixedFooter].filter(Boolean).join('\n\n');

  return {
    introduction,
    metadata: {
      tipo_proposta: typeKey,
      tipo_proposta_label: typeRule.label,
      solucao: solution,
      meses: months,
      moeda: currency,
      valor_calculado: Number(total.toFixed(2)),
      prazo_entrega_dias: deliveryDays,
      prazo_entrega_texto: deliveryTerm || null,
      prazo_entrega_data: deliveryDate,
      valor_frete: freightFormatted || null,
      sla: sla || null,
      introducao_substituida: true,
      hubspot_pipeline: typeRule.hubspot_pipeline,
      hubspot_stage_aguardando_proposta: typeRule.hubspot_stage_aguardando_proposta,
      hubspot_stage_proposta_enviada: typeRule.hubspot_stage_proposta_enviada
    }
  };
}

async function hubspotSearch(objectType, propertyName, value, properties = [], context = {}) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: String(value) }] }],
      properties,
      limit: 10
    },
    ...context,
  });
}
async function hubspotCreate(objectType, properties, context = {}) {
  return hubspotRequest(`/crm/v3/objects/${objectType}`, { method: 'POST', body: { properties }, ...context });
}
async function hubspotUpdate(objectType, objectId, properties, context = {}) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, { method: 'PATCH', body: { properties }, ...context });
}
async function hubspotAssociate(fromType, fromId, toType, toId, context = {}) {
  return hubspotRequest(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`, { method: 'PUT', ...context });
}
async function hubspotGet(objectType, objectId, properties = [], context = {}) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(','))}` : '';
  return hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}${qs}`, context);
}

async function findOrCreateCompany({ empresa, domain }, correlationId) {
  const context = { correlationId, operation: 'ensure_hubspot_company' };
  const search = await hubspotSearch('companies', 'domain', domain, ['name', 'domain', 'hubspot_owner_id'], context);
  if (search.total > 0) return { record: search.results[0], created: false };
  try {
    const record = await hubspotCreate('companies', { name: empresa, domain }, context);
    const verification = await hubspotSearch('companies', 'domain', domain, ['name', 'domain'], context);
    return { record, created: true, verification: verification.total > 0 ? 'found' : 'eventual_consistency' };
  } catch (error) {
    try {
      const verification = await hubspotSearch('companies', 'domain', domain, ['name', 'domain'], context);
      if (verification.total > 0) {
        return { record: verification.results[0], created: true, recovered_after_error: true, verification: 'found' };
      }
    } catch (verificationError) {
      error.verification_error = {
        message: verificationError instanceof Error ? verificationError.message : 'company_verification_failed',
        status: verificationError?.status ?? null,
        data: sanitizePayload(verificationError?.data ?? null),
      };
    }
    error.taxonomy = ERROR_TAXONOMY.WRITE_UNCERTAIN;
    throw error;
  }
}

async function findOrCreateContact({ email, firstname, lastname, companyId }, correlationId) {
  if (!email) return { record: null, created: false };
  const context = { correlationId, operation: 'ensure_hubspot_contact' };
  const search = await hubspotSearch('contacts', 'email', email, ['email', 'firstname', 'lastname'], context);
  let record;
  let created = false;
  if (search.total > 0) record = search.results[0];
  else {
    const properties = { email };
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    try {
      record = await hubspotCreate('contacts', properties, context);
      created = true;
      const verification = await hubspotSearch('contacts', 'email', email, ['email', 'firstname', 'lastname'], context);
      if (verification.total > 0) record = verification.results[0];
    } catch (error) {
      try {
        const verification = await hubspotSearch('contacts', 'email', email, ['email', 'firstname', 'lastname'], context);
        if (verification.total > 0) {
          record = verification.results[0];
          created = true;
          if (companyId && record?.id) await hubspotAssociate('contact', record.id, 'company', companyId, context);
          return { record, created, recovered_after_error: true };
        }
      } catch (verificationError) {
        error.verification_error = {
          message: verificationError instanceof Error ? verificationError.message : 'contact_verification_failed',
          status: verificationError?.status ?? null,
          data: sanitizePayload(verificationError?.data ?? null),
        };
      }
      error.taxonomy = ERROR_TAXONOMY.WRITE_UNCERTAIN;
      throw error;
    }
  }
  if (companyId && record?.id) await hubspotAssociate('contact', record.id, 'company', companyId, context);
  return { record, created };
}

function normalizeContacts(body) {
  if (Array.isArray(body.contatos)) {
    return body.contatos
      .map(c => ({ email: String(c?.email || '').trim().toLowerCase(), firstname: String(c?.nome || c?.firstname || '').trim(), lastname: String(c?.sobrenome || c?.lastname || '').trim() }))
      .filter(c => c.email);
  }
  if (body.contato_email) {
    return [{ email: String(body.contato_email).trim().toLowerCase(), firstname: String(body.contato_nome || '').trim(), lastname: String(body.contato_sobrenome || '').trim() }];
  }
  return [];
}

async function findOrCreateContacts(contacts, companyId, correlationId) {
  const results = [];
  for (const contact of contacts) {
    const found = await findOrCreateContact({ ...contact, companyId }, correlationId);
    if (found.record) results.push({ id: found.record.id, created: found.created, email: contact.email, firstname: found.record.properties?.firstname || contact.firstname || '', lastname: found.record.properties?.lastname || contact.lastname || '' });
  }
  return results;
}

function calculateDealAmount(body, typeKey) {
  if (typeKey === 'locacao' && body.valor_mensal !== undefined) {
    const months = Number(body.meses);
    if (!Number.isInteger(months) || months <= 0) throw requestError('meses e obrigatorio para calcular o valor contratual da locacao', { field: 'meses' });
    const monthly = parseMoney(body.valor_mensal, 'valor_mensal');
    return { amount: Number((monthly * months).toFixed(2)), monthly, months, rule: 'monthly_value_times_months' };
  }
  const amount = parseMoney(body.valor_negocio, 'valor_negocio');
  return { amount: Number(amount.toFixed(2)), monthly: null, months: body.meses ? Number(body.meses) : null, rule: 'explicit_value' };
}

const HUBSPOT_ENUM_ALIASES = {
  solucao: {
    'locacao de switch': 'Cisco',
    'locacao switch': 'Cisco',
    'locacao de switches': 'Cisco',
  },
};

async function resolveHubSpotDealConfig(typeRule, suppliedSolution, correlationId) {
  const context = { correlationId, operation: 'validate_hubspot_deal_configuration' };
  const [solutionDefinition, pipeline] = await Promise.all([
    hubspotRequest('/crm/v3/properties/deals/solucao', context),
    hubspotRequest(`/crm/v3/pipelines/deals/${encodeURIComponent(typeRule.hubspot_pipeline)}`, context),
  ]);
  const solution = resolveEnumOption(
    'solucao',
    suppliedSolution,
    Array.isArray(solutionDefinition?.options) ? solutionDefinition.options : [],
    HUBSPOT_ENUM_ALIASES,
  );
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : [];
  const stageValid = stages.some((stage) => String(stage?.id) === String(typeRule.hubspot_stage_aguardando_proposta));
  if (!stageValid) {
    const error = requestError('HubSpot pipeline/stage configuration is invalid', {
      pipeline: typeRule.hubspot_pipeline,
      stage: typeRule.hubspot_stage_aguardando_proposta,
    });
    error.taxonomy = ERROR_TAXONOMY.VALIDATION_ERROR;
    throw error;
  }
  return { solution, pipeline: String(pipeline?.id || typeRule.hubspot_pipeline), stage: String(typeRule.hubspot_stage_aguardando_proposta) };
}

function dealEquivalence(resource, expected) {
  const properties = resource?.properties || {};
  const mismatches = [];
  const compare = (field, actual, wanted) => {
    if (actual === undefined || actual === null || wanted === undefined || wanted === null) return;
    if (normalizeComparable(actual) !== normalizeComparable(wanted)) mismatches.push({ field, expected: wanted, actual });
  };
  compare('numero_da_proposta', properties.numero_da_proposta, expected.numero_da_proposta);
  compare('pipeline', properties.pipeline, expected.pipeline);
  compare('dealstage', properties.dealstage, expected.dealstage);
  compare('solucao', properties.solucao, expected.solucao);
  compare('amount', properties.amount, expected.amount);
  return { equivalent: mismatches.length === 0, mismatches };
}

async function verifyDealWrite(numero, expected, correlationId) {
  const delays = [0, 400, 900];
  let last = null;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      last = await hubspotSearch(
        'deals',
        'numero_da_proposta',
        numero,
        ['dealname', 'numero_da_proposta', 'link_da_proposta', 'solucao', 'pipeline', 'dealstage', 'amount', 'deal_currency_code'],
        { correlationId, operation: 'verify_hubspot_deal' },
      );
      if (Number(last?.total || 0) > 0) {
        const resource = last.results[0];
        const comparison = dealEquivalence(resource, expected);
        return {
          outcome: 'found',
          equivalent: comparison.equivalent,
          resource,
          details: { attempts: attempt + 1, mismatches: comparison.mismatches },
        };
      }
    } catch (error) {
      last = {
        message: error instanceof Error ? error.message : 'deal_verification_failed',
        http_status: error?.status ?? null,
        downstream_response: sanitizePayload(error?.data ?? null),
      };
    }
  }
  if (last && typeof last === 'object' && Object.prototype.hasOwnProperty.call(last, 'message')) {
    return { outcome: 'inconclusive', details: { attempts: delays.length, last } };
  }
  return { outcome: 'absent', details: { attempts: delays.length, last: sanitizePayload(last) } };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', service: 'seta-erp-connector', configured: getMissingEnv().length === 0, hubspot_configured: Boolean(HUBSPOT_ACCESS_TOKEN) }));
app.use('/erp', auth);

app.get('/erp/clientes', async (req, res) => { try { res.json(await betelRequest('/clientes', { query: req.query })); } catch (err) { handleError(err, res); } });
app.post('/erp/clientes', async (req, res) => { try { res.json(await betelRequest('/clientes', { method: 'POST', body: req.body })); } catch (err) { handleError(err, res); } });
app.get('/erp/produtos', async (req, res) => { try { res.json(await betelRequest('/produtos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/usuarios', async (req, res) => { try { res.json(await betelRequest('/usuarios', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/situacoes-orcamentos', async (req, res) => { try { res.json(await betelRequest('/situacoes_orcamentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/orcamentos', async (req, res) => { try { res.json(await betelRequest('/orcamentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/orcamentos/:id', async (req, res) => {
  try {
    const result = await betelRequest(`/orcamentos/${encodeURIComponent(req.params.id)}`);
    const publicLink = await resolvePublicProposalLink(result);
    res.json({ ...result, ...publicLink });
  } catch (err) { handleError(err, res); }
});
app.put('/erp/orcamentos/:id', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const currentResult = await betelRequest(`/orcamentos/${id}`);
    const current = extractProposalData(currentResult);
    if (!current) throw requestError('Nao foi possivel interpretar a proposta atual antes da edicao', { id: req.params.id });

    const { payload, changes } = buildProposalEditPayload(current, req.body || {});
    const updateResult = await betelRequest(`/orcamentos/${id}`, { method: 'PUT', body: payload });
    const refreshedResult = await betelRequest(`/orcamentos/${id}`);
    const refreshed = extractProposalData(refreshedResult);
    const publicLink = await resolvePublicProposalLink(refreshedResult);

    res.json({
      status: 'success',
      action: 'proposal_updated',
      id: String(req.params.id),
      codigo: refreshed?.codigo ?? current?.codigo ?? null,
      changes_requested: changes,
      before: Object.fromEntries(Object.keys(changes).map(field => [field, current?.[field] ?? null])),
      after: Object.fromEntries(Object.keys(changes).map(field => [field, refreshed?.[field] ?? null])),
      proposal: updateResult,
      verification: refreshedResult,
      ...publicLink
    });
  } catch (err) { handleError(err, res); }
});
app.post('/erp/orcamentos', async (req, res) => {
  try {
    const correlationId = req.correlationId;
    const { introduction, metadata } = buildProposalIntroduction(req.body || {});
    const {
      tipo_proposta,
      solucao,
      meses,
      moeda,
      prazo_entrega_dias,
      sla,
      introducao: _introducaoExistente,
      ...betelBody
    } = req.body || {};
    betelBody.introducao = introduction;
    if (metadata.prazo_entrega_data) betelBody.prazo_entrega = metadata.prazo_entrega_data;
    const numero = String(betelBody.codigo || '').trim();
    if (!/^\d+$/.test(numero)) throw requestError('codigo comercial da proposta deve ser numerico', { field: 'codigo' });

    const precheck = await verifyProposalWrite(numero, betelBody, correlationId);
    if (precheck.outcome === 'found') {
      return res.status(200).json({
        operation: 'create_proposal',
        write_attempted: false,
        http_status: null,
        downstream_response: null,
        verification: { performed: true, found: true, equivalent: precheck.equivalent, numero, resource: sanitizePayload(precheck.resource), details: precheck.details },
        effective_status: EFFECTIVE_STATUS.DUPLICATE,
        error_taxonomy: ERROR_TAXONOMY.DUPLICATE,
        endpoint: '/orcamentos',
        request_correlation_id: correlationId,
        sanitized_payload: sanitizePayload(betelBody),
        timestamp: new Date().toISOString(),
      });
    }
    if (precheck.outcome === 'inconclusive') {
      return res.status(200).json({
        operation: 'create_proposal',
        write_attempted: false,
        verification: { performed: true, found: null, outcome: 'inconclusive', details: precheck.details },
        effective_status: EFFECTIVE_STATUS.WRITE_UNCERTAIN,
        error_taxonomy: ERROR_TAXONOMY.WRITE_UNCERTAIN,
        endpoint: '/orcamentos',
        request_correlation_id: correlationId,
        sanitized_payload: sanitizePayload(betelBody),
        timestamp: new Date().toISOString(),
      });
    }

    const reconciliation = await reconcileWrite({
      operation: 'create_proposal',
      endpoint: '/orcamentos',
      correlationId,
      payload: betelBody,
      write: () => betelRequest('/orcamentos', {
        method: 'POST',
        body: betelBody,
        correlationId,
        operation: 'create_proposal',
        observe: true,
      }),
      verify: () => verifyProposalWrite(numero, betelBody, correlationId),
    });
    const canContinue = [EFFECTIVE_STATUS.SUCCESS, EFFECTIVE_STATUS.SUCCESS_RECOVERED]
      .includes(reconciliation.effective_status);
    const publicLink = canContinue
      ? await resolvePublicProposalLink(reconciliation.verification.resource || reconciliation.downstream_response)
      : {};
    return res.status(200).json({
      status: canContinue ? 'success' : 'error',
      ...reconciliation,
      proposal: reconciliation.downstream_response,
      commercial: metadata,
      introducao_enviada: introduction,
      introducao_substituida: true,
      prazo_entrega_enviado: metadata.prazo_entrega_data,
      ...publicLink
    });
  } catch (err) { handleError(err, res); }
});

app.get('/erp/hubspot/configuracao-proposta', (req, res) => {
  try { res.json({ status: 'success', data: loadProposalRules() }); } catch (err) { handleError(err, res); }
});
app.get('/erp/hubspot/empresas', async (req, res) => {
  try {
    if (!req.query.domain) throw requestError('domain e obrigatorio', { field: 'domain' });
    res.json(await hubspotSearch('companies', 'domain', req.query.domain, ['name', 'domain', 'hubspot_owner_id']));
  } catch (err) { handleError(err, res); }
});
app.get('/erp/hubspot/empresas/:id/contatos', async (req, res) => {
  try {
    const associations = await hubspotRequest(`/crm/v4/objects/companies/${encodeURIComponent(req.params.id)}/associations/contacts?limit=100`);
    const ids = (associations.results || []).map(item => item.toObjectId).filter(Boolean);
    const contacts = [];
    for (const id of ids) contacts.push(await hubspotGet('contacts', id, ['email', 'firstname', 'lastname']));
    res.json({ status: 'success', total: contacts.length, results: contacts });
  } catch (err) { handleError(err, res); }
});
app.get('/erp/hubspot/contatos', async (req, res) => {
  try {
    if (!req.query.email) throw requestError('email e obrigatorio', { field: 'email' });
    res.json(await hubspotSearch('contacts', 'email', req.query.email, ['email', 'firstname', 'lastname']));
  } catch (err) { handleError(err, res); }
});
app.get('/erp/hubspot/negocios', async (req, res) => {
  try {
    if (!req.query.numero_proposta) throw requestError('numero_proposta e obrigatorio', { field: 'numero_proposta' });
    res.json(await hubspotSearch('deals', 'numero_da_proposta', req.query.numero_proposta, ['dealname', 'numero_da_proposta', 'link_da_proposta', 'solucao', 'pipeline', 'dealstage', 'amount', 'deal_currency_code']));
  } catch (err) { handleError(err, res); }
});

app.post('/erp/hubspot/negocios-da-proposta', async (req, res) => {
  try {
    const correlationId = req.correlationId;
    const body = req.body || {};
    const numero = String(body.numero_proposta || '').trim();
    const empresa = String(body.empresa || '').trim();
    const domain = String(body.domain || '').trim().toLowerCase();
    const solucaoComercial = String(body.solucao || '').trim();
    const link = String(body.link_proposta || '').trim();
    const currency = String(body.moeda || 'BRL').trim().toUpperCase();
    const { rules, typeKey, typeRule } = getProposalTypeRule(body.tipo_proposta);
    const amountData = calculateDealAmount(body, typeKey);

    if (!numero) throw requestError('numero_proposta e obrigatorio', { field: 'numero_proposta' });
    if (!empresa) throw requestError('empresa e obrigatoria', { field: 'empresa' });
    if (!domain) throw requestError('domain e obrigatorio para localizar/criar a empresa no HubSpot', { field: 'domain' });
    if (!solucaoComercial) throw requestError('solucao e obrigatoria', { field: 'solucao' });
    if (!link) throw requestError('link_proposta e obrigatorio antes de criar o Deal', { field: 'link_proposta' });
    if (!['BRL', 'USD'].includes(currency)) throw requestError('moeda invalida', { field: 'moeda', allowed: ['BRL', 'USD'] });
    if (amountData.amount < 0) throw requestError('valor do negocio nao pode ser negativo', { field: 'valor_negocio' });

    const resolvedConfig = await resolveHubSpotDealConfig(typeRule, solucaoComercial, correlationId);
    const solucao = resolvedConfig.solution;

    const dealName = String(rules.deal_name_pattern || '{numero_proposta} - {empresa} - {solucao}')
      .replaceAll('{numero_proposta}', numero).replaceAll('{empresa}', empresa).replaceAll('{solucao}', solucaoComercial);
    const properties = {
      dealname: dealName,
      pipeline: resolvedConfig.pipeline,
      dealstage: resolvedConfig.stage,
      numero_da_proposta: numero,
      link_da_proposta: link,
      solucao,
      amount: String(amountData.amount),
      deal_currency_code: currency
    };
    if (body.hubspot_owner_id) properties.hubspot_owner_id = String(body.hubspot_owner_id);

    const duplicate = await hubspotSearch(
      'deals',
      rules.workflow.deal_number_property || 'numero_da_proposta',
      numero,
      ['dealname', 'numero_da_proposta', 'link_da_proposta', 'solucao', 'pipeline', 'dealstage', 'amount'],
      { correlationId, operation: 'precheck_hubspot_deal_duplicate' },
    );
    if (duplicate.total > 0) {
      const comparison = dealEquivalence(duplicate.results[0], properties);
      return res.status(200).json({
        operation: 'create_hubspot_deal',
        write_attempted: false,
        http_status: null,
        downstream_response: null,
        verification: { performed: true, found: true, equivalent: comparison.equivalent, resource: duplicate.results[0], details: comparison },
        effective_status: EFFECTIVE_STATUS.DUPLICATE,
        error_taxonomy: ERROR_TAXONOMY.DUPLICATE,
        endpoint: '/crm/v3/objects/deals',
        request_correlation_id: correlationId,
        sanitized_payload: sanitizePayload({ properties }),
        timestamp: new Date().toISOString(),
      });
    }

    const companyResult = await findOrCreateCompany({ empresa, domain }, correlationId);
    const selectedContacts = normalizeContacts(body);
    const contacts = await findOrCreateContacts(selectedContacts, companyResult.record.id, correlationId);

    const reconciliation = await reconcileWrite({
      operation: 'create_hubspot_deal',
      endpoint: '/crm/v3/objects/deals',
      correlationId,
      payload: { properties },
      acceptDirectEvidence: true,
      directEvidence: (value) => Boolean(value?.id),
      write: () => hubspotRequest('/crm/v3/objects/deals', {
        method: 'POST',
        body: { properties },
        correlationId,
        operation: 'create_hubspot_deal',
        observe: true,
      }),
      verify: () => verifyDealWrite(numero, properties, correlationId),
    });
    const canContinue = [EFFECTIVE_STATUS.SUCCESS, EFFECTIVE_STATUS.SUCCESS_RECOVERED]
      .includes(reconciliation.effective_status);
    const deal = reconciliation.downstream_response?.id
      ? reconciliation.downstream_response
      : reconciliation.verification?.resource;
    const associationResults = [];
    const associationFailures = [];
    if (canContinue && deal?.id) {
      const targets = [
        { type: 'company', id: companyResult.record.id },
        ...contacts.map((contact) => ({ type: 'contact', id: contact.id })),
      ];
      for (const target of targets) {
        try {
          await hubspotAssociate('deal', deal.id, target.type, target.id, {
            correlationId,
            operation: 'associate_hubspot_deal',
          });
          associationResults.push(target);
        } catch (error) {
          associationFailures.push({ ...target, message: error instanceof Error ? error.message : 'association_failed' });
        }
      }
    }

    return res.status(200).json({
      status: canContinue ? (associationFailures.length ? 'partial_success' : 'success') : 'error',
      ...reconciliation,
      deal,
      deal_name: dealName,
      tipo_proposta: typeKey,
      pipeline: resolvedConfig.pipeline,
      dealstage: resolvedConfig.stage,
      solucao_comercial: solucaoComercial,
      solucao_internal_value: solucao,
      amount: amountData,
      company: { id: companyResult.record.id, created: companyResult.created, domain },
      contacts,
      associations: associationResults,
      association_failures: associationFailures,
      email_workflow: rules.email || null
    });
  } catch (err) { handleError(err, res); }
});

app.post('/erp/hubspot/negocios/:id/marcar-proposta-enviada', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.envio_confirmado !== true) throw requestError('envio_confirmado deve ser true. A etapa so pode mudar depois de confirmar o envio real do e-mail.', { field: 'envio_confirmado' });
    const { typeKey, typeRule } = getProposalTypeRule(body.tipo_proposta);
    const properties = { dealstage: typeRule.hubspot_stage_proposta_enviada };
    if (body.solucao) properties.solucao = String(body.solucao).trim();
    const deal = await hubspotUpdate('deals', req.params.id, properties);
    res.json({ status: 'success', deal, tipo_proposta: typeKey, dealstage: typeRule.hubspot_stage_proposta_enviada, envio_confirmado: true });
  } catch (err) { handleError(err, res); }
});

app.get('/erp/recebimentos', async (req, res) => { try { res.json(await betelRequest('/recebimentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/recebimentos/:id', async (req, res) => { try { res.json(await betelRequest(`/recebimentos/${encodeURIComponent(req.params.id)}`)); } catch (err) { handleError(err, res); } });
app.post('/erp/recebimentos', async (req, res) => { try { res.json(await betelRequest('/recebimentos', { method: 'POST', body: req.body })); } catch (err) { handleError(err, res); } });
app.get('/erp/planos-contas', async (req, res) => { try { res.json(await betelRequest('/planos_contas', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/formas-pagamentos', async (req, res) => { try { res.json(await betelRequest('/formas_pagamentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/contas-bancarias', async (req, res) => { try { res.json(await betelRequest('/contas_bancarias', { query: req.query })); } catch (err) { handleError(err, res); } });

app.get('/erp/regras-faturamento', (req, res) => {
  try {
    const rule = findBillingRule({ cliente: req.query.cliente, cliente_id: req.query.cliente_id });
    if (!rule) return res.status(404).json({ error: 'billing_rule_not_found', message: 'Nenhuma regra de faturamento cadastrada para este cliente.' });
    res.json({ status: 'success', data: rule });
  } catch (err) { handleError(err, res); }
});
app.post('/erp/regras-faturamento/calcular', (req, res) => {
  try {
    const { cliente, cliente_id, vencimento_anterior, data_edicao } = req.body || {};
    const rule = findBillingRule({ cliente, cliente_id });
    if (!rule) return res.status(404).json({ error: 'billing_rule_not_found', message: 'Nenhuma regra de faturamento cadastrada para este cliente.' });
    const previousDue = parseIsoDate(vencimento_anterior, 'vencimento_anterior');
    parseIsoDate(data_edicao, 'data_edicao');
    if (rule.vencimento.base !== 'vencimento_fatura_anterior') return res.status(400).json({ error: 'unsupported_billing_rule', message: 'Base de vencimento ainda nao suportada pelo calculador.' });
    const minimumDate = addDaysUtc(previousDue, Number(rule.vencimento.dias_minimos || 0));
    let dueDate = minimumDate;
    if (rule.vencimento.ajuste_dia_semana === 'quarta-feira' && rule.vencimento.regra_ajuste === 'primeira_quarta_igual_ou_posterior') dueDate = nextWednesdayOnOrAfter(minimumDate);
    res.json({ status: 'success', data: {
      cliente: rule.cliente_nome,
      regra_key: rule.key,
      data_emissao: data_edicao,
      vencimento_anterior,
      dias_minimos: rule.vencimento.dias_minimos,
      data_minima_sem_ajuste: formatIsoDate(minimumDate),
      novo_vencimento: formatIsoDate(dueDate),
      dia_semana_vencimento: 'quarta-feira',
      regra_aplicada: rule.vencimento.regra_ajuste,
      exige_confirmacao_antes_de_gerar: Boolean(rule.workflow?.exigir_confirmacao_antes_de_gerar)
    }});
  } catch (err) { handleError(err, res); }

// Helper: Deletar Deal no HubSpot
async function hubspotDelete(objectType, objectId, context = {}) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, { method: 'DELETE', ...context });
}

// Helper: Verificar existência do deal (GET retorna 404 se não existe)
async function verifyDealExists(dealId, correlationId) {
  try {
    const properties = ['dealname', 'numero_da_proposta', 'pipeline', 'dealstage', 'amount'];
    const deal = await hubspotGet('deals', dealId, properties, {
      correlationId,
      operation: 'verify_deal_exists'
    });
    return { exists: true, deal };
  } catch (err) {
    if (err.status === 404) return { exists: false, deal: null };
    throw err;
  }
}

// DELETE /erp/hubspot/negocios/:id - Deletar Deal do HubSpot
app.delete('/erp/hubspot/negocios/:id', async (req, res) => {
  try {
    const correlationId = req.correlationId;
    const dealId = String(req.params.id || '').trim();
    
    if (!dealId) throw requestError('deal_id (ID interno do HubSpot) e obrigatorio no caminho', { field: 'deal_id', note: 'Use o ID interno do HubSpot, nunca o numero de proposta' });
    
    // Step 1: GET preview - evidência do deal antes do delete
    let preview;
    try {
      const previewResult = await verifyDealExists(dealId, correlationId);
      if (!previewResult.exists) {
        return res.status(404).json({
          status: 'not_found',
          message: 'Deal nao encontrado no HubSpot',
          deal_id: dealId,
          request_correlation_id: correlationId,
          timestamp: new Date().toISOString()
        });
      }
      preview = previewResult.deal;
    } catch (err) {
      err.operation = 'delete_hubspot_deal_preview';
      throw err;
    }
    
    // Step 2: DELETE - Executar deleção no HubSpot
    let deleteResult;
    try {
      deleteResult = await hubspotDelete('deals', dealId, {
        correlationId,
        operation: 'delete_hubspot_deal'
      });
    } catch (err) {
      err.operation = 'delete_hubspot_deal_delete';
      throw err;
    }
    
    // Step 3: GET verificação - Confirmar ausência via 404
    let verificationOutcome = 'success';
    let verificationError = null;
    try {
      const verifyResult = await verifyDealExists(dealId, correlationId);
      if (verifyResult.exists) {
        verificationOutcome = 'verification_failed';
        verificationError = 'Deal still exists after DELETE request';
      } else {
        verificationOutcome = 'success';
      }
    } catch (err) {
      if (err.status === 404) {
        verificationOutcome = 'success';
      } else {
        verificationError = err.message;
        verificationOutcome = 'verification_inconclusive';
      }
    }
    
    return res.status(200).json({
      status: verificationOutcome === 'success' ? 'success' : 'partial_success',
      message: verificationOutcome === 'success' ? 'Deal deletado com sucesso' : 'Deal pode ter sido deletado, mas verificacao foi inconclusiva',
      deal_id: dealId,
      preview: sanitizePayload(preview),
      delete_evidence: {
        operation: 'delete_hubspot_deal',
        http_method: 'DELETE',
        endpoint: `/crm/v3/objects/deals/${dealId}`,
        status: 'executed'
      },
      verification: {
        outcome: verificationOutcome,
        error: verificationError
      },
      request_correlation_id: correlationId,
      timestamp: new Date().toISOString(),
      notes: [
        'Empresa (company) e contatos (contact) nao foram deletados - apenas a associacao com o deal foi removida',
        'Preview documentou o deal antes da deleção',
        'Verificacao por GET confirma ausência via status 404'
      ]
    });
  } catch (err) {
    handleError(err, res);
  }
});

});

app.listen(PORT, '0.0.0.0', () => console.log(`Seta ERP Connector listening on 0.0.0.0:${PORT}`));
