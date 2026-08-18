import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

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

async function betelRequest(path, { method = 'GET', query, body } = {}) {
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
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (response.ok) return data;

      const err = new Error(`Betel API error ${response.status}`);
      err.status = response.status;
      err.data = data;
      err.source = 'betel';
      lastError = err;
      if (method === 'GET' && response.status >= 500 && attempt < maxAttempts) {
        await sleep(400);
        continue;
      }
      throw err;
    } catch (err) {
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

async function hubspotRequest(path, { method = 'GET', body } = {}) {
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
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (response.ok) return data;

  const err = new Error(`HubSpot API error ${response.status}`);
  err.status = response.status;
  err.data = data;
  err.source = 'hubspot';
  throw err;
}

function handleError(err, res) {
  console.error(err);
  if (err.status) {
    return res.status(err.status).json({
      error: `${err.source || 'request'}_error`,
      status: err.status,
      message: err.message,
      details: err.data
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
  return currency === 'USD' ? `US$ ${number.toFixed(2)}` : `R$ ${number.toFixed(2)}`;
}

function getProposalTypeRule(typeKey) {
  const rules = loadProposalRules();
  const normalized = normalizeText(typeKey);
  const typeRule = rules.types?.[normalized];
  if (!typeRule) throw requestError('tipo_proposta invalido', { field: 'tipo_proposta', allowed: Object.keys(rules.types || {}) });
  return { rules, typeKey: normalized, typeRule };
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

  const introduction = String(pattern || typeRule.label)
    .replaceAll('{meses}', String(months ?? ''))
    .replaceAll('{valor_formatado}', formattedValue);

  return {
    introduction,
    metadata: {
      tipo_proposta: typeKey,
      tipo_proposta_label: typeRule.label,
      solucao: solution,
      meses: months,
      moeda: currency,
      valor_calculado: Number(total.toFixed(2)),
      hubspot_pipeline: typeRule.hubspot_pipeline,
      hubspot_stage_aguardando_proposta: typeRule.hubspot_stage_aguardando_proposta,
      hubspot_stage_proposta_enviada: typeRule.hubspot_stage_proposta_enviada
    }
  };
}

async function hubspotSearch(objectType, propertyName, value, properties = []) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: String(value) }] }],
      properties,
      limit: 10
    }
  });
}
async function hubspotCreate(objectType, properties) {
  return hubspotRequest(`/crm/v3/objects/${objectType}`, { method: 'POST', body: { properties } });
}
async function hubspotUpdate(objectType, objectId, properties) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, { method: 'PATCH', body: { properties } });
}
async function hubspotAssociate(fromType, fromId, toType, toId) {
  return hubspotRequest(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`, { method: 'PUT' });
}
async function hubspotGet(objectType, objectId, properties = []) {
  const qs = properties.length ? `?properties=${encodeURIComponent(properties.join(','))}` : '';
  return hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}${qs}`);
}

async function findOrCreateCompany({ empresa, domain }) {
  const search = await hubspotSearch('companies', 'domain', domain, ['name', 'domain', 'hubspot_owner_id']);
  if (search.total > 0) return { record: search.results[0], created: false };
  return { record: await hubspotCreate('companies', { name: empresa, domain }), created: true };
}

async function findOrCreateContact({ email, firstname, lastname, companyId }) {
  if (!email) return { record: null, created: false };
  const search = await hubspotSearch('contacts', 'email', email, ['email', 'firstname', 'lastname']);
  let record;
  let created = false;
  if (search.total > 0) record = search.results[0];
  else {
    const properties = { email };
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    record = await hubspotCreate('contacts', properties);
    created = true;
  }
  if (companyId && record?.id) await hubspotAssociate('contact', record.id, 'company', companyId);
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

async function findOrCreateContacts(contacts, companyId) {
  const results = [];
  for (const contact of contacts) {
    const found = await findOrCreateContact({ ...contact, companyId });
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

function parseIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw requestError(`${fieldName} deve estar no formato YYYY-MM-DD`, { field: fieldName, expected_format: 'YYYY-MM-DD' });
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw requestError(`${fieldName} invalida`, { field: fieldName });
  return date;
}
function formatIsoDate(date) { return date.toISOString().slice(0, 10); }
function addDaysUtc(date, days) { const result = new Date(date.getTime()); result.setUTCDate(result.getUTCDate() + days); return result; }
function nextWednesdayOnOrAfter(date) { return addDaysUtc(date, (3 - date.getUTCDay() + 7) % 7); }

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', service: 'seta-erp-connector', configured: getMissingEnv().length === 0, hubspot_configured: Boolean(HUBSPOT_ACCESS_TOKEN) }));
app.use('/erp', auth);

app.get('/erp/clientes', async (req, res) => { try { res.json(await betelRequest('/clientes', { query: req.query })); } catch (err) { handleError(err, res); } });
app.post('/erp/clientes', async (req, res) => { try { res.json(await betelRequest('/clientes', { method: 'POST', body: req.body })); } catch (err) { handleError(err, res); } });
app.get('/erp/produtos', async (req, res) => { try { res.json(await betelRequest('/produtos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/usuarios', async (req, res) => { try { res.json(await betelRequest('/usuarios', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/situacoes-orcamentos', async (req, res) => { try { res.json(await betelRequest('/situacoes_orcamentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/orcamentos', async (req, res) => { try { res.json(await betelRequest('/orcamentos', { query: req.query })); } catch (err) { handleError(err, res); } });
app.get('/erp/orcamentos/:id', async (req, res) => { try { res.json(await betelRequest(`/orcamentos/${encodeURIComponent(req.params.id)}`)); } catch (err) { handleError(err, res); } });
app.post('/erp/orcamentos', async (req, res) => {
  try {
    const { introduction, metadata } = buildProposalIntroduction(req.body || {});
    const { tipo_proposta, solucao, meses, moeda, ...betelBody } = req.body || {};
    betelBody.introducao = introduction;
    const result = await betelRequest('/orcamentos', { method: 'POST', body: betelBody });
    res.json({ status: 'success', proposal: result, commercial: metadata, introducao_enviada: introduction });
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
    const body = req.body || {};
    const numero = String(body.numero_proposta || '').trim();
    const empresa = String(body.empresa || '').trim();
    const domain = String(body.domain || '').trim().toLowerCase();
    const solucao = String(body.solucao || '').trim();
    const link = String(body.link_proposta || '').trim();
    const currency = String(body.moeda || 'BRL').trim().toUpperCase();
    const { rules, typeKey, typeRule } = getProposalTypeRule(body.tipo_proposta);
    const amountData = calculateDealAmount(body, typeKey);

    if (!numero) throw requestError('numero_proposta e obrigatorio', { field: 'numero_proposta' });
    if (!empresa) throw requestError('empresa e obrigatoria', { field: 'empresa' });
    if (!domain) throw requestError('domain e obrigatorio para localizar/criar a empresa no HubSpot', { field: 'domain' });
    if (!solucao) throw requestError('solucao e obrigatoria', { field: 'solucao' });
    if (!link) throw requestError('link_proposta e obrigatorio antes de criar o Deal', { field: 'link_proposta' });
    if (!['BRL', 'USD'].includes(currency)) throw requestError('moeda invalida', { field: 'moeda', allowed: ['BRL', 'USD'] });
    if (amountData.amount < 0) throw requestError('valor do negocio nao pode ser negativo', { field: 'valor_negocio' });

    const duplicate = await hubspotSearch('deals', rules.workflow.deal_number_property || 'numero_da_proposta', numero, ['dealname', 'numero_da_proposta', 'link_da_proposta']);
    if (duplicate.total > 0) return res.status(409).json({ error: 'deal_duplicate', message: 'Ja existe um negocio no HubSpot com este numero de proposta.', existing: duplicate.results[0] });

    const companyResult = await findOrCreateCompany({ empresa, domain });
    const selectedContacts = normalizeContacts(body);
    const contacts = await findOrCreateContacts(selectedContacts, companyResult.record.id);

    const dealName = String(rules.deal_name_pattern || '{numero_proposta} - {empresa} - {solucao}')
      .replaceAll('{numero_proposta}', numero).replaceAll('{empresa}', empresa).replaceAll('{solucao}', solucao);
    const properties = {
      dealname: dealName,
      pipeline: typeRule.hubspot_pipeline,
      dealstage: typeRule.hubspot_stage_aguardando_proposta,
      numero_da_proposta: numero,
      link_da_proposta: link,
      solucao,
      amount: String(amountData.amount),
      deal_currency_code: currency
    };
    if (body.hubspot_owner_id) properties.hubspot_owner_id = String(body.hubspot_owner_id);

    const deal = await hubspotCreate('deals', properties);
    await hubspotAssociate('deal', deal.id, 'company', companyResult.record.id);
    for (const contact of contacts) await hubspotAssociate('deal', deal.id, 'contact', contact.id);

    res.json({
      status: 'success',
      deal,
      deal_name: dealName,
      tipo_proposta: typeKey,
      pipeline: typeRule.hubspot_pipeline,
      dealstage: typeRule.hubspot_stage_aguardando_proposta,
      amount: amountData,
      company: { id: companyResult.record.id, created: companyResult.created, domain },
      contacts,
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
});

app.listen(PORT, '0.0.0.0', () => console.log(`Seta ERP Connector listening on 0.0.0.0:${PORT}`));
