import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

function getMissingEnv() {
  const missing = [];
  if (!BETEL_ACCESS_TOKEN) missing.push('BETEL_ACCESS_TOKEN');
  if (!BETEL_SECRET_ACCESS_TOKEN) missing.push('BETEL_SECRET_ACCESS_TOKEN');
  if (!CONNECTOR_API_KEY) missing.push('CONNECTOR_API_KEY');
  return missing;
}

const missingAtStartup = getMissingEnv();
if (missingAtStartup.length) {
  console.warn(`Connector started with missing environment variables: ${missingAtStartup.join(', ')}`);
}

function auth(req, res, next) {
  const missing = getMissingEnv();
  if (missing.length) {
    return res.status(503).json({ error: 'connector_not_configured', missing });
  }
  const expected = `Bearer ${CONNECTOR_API_KEY}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cleanQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.append(key, String(value));
    }
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
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (response.ok) return data;

      const err = new Error(`Betel API error ${response.status}`);
      err.status = response.status;
      err.data = data;
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

function handleError(err, res) {
  console.error(err);
  if (err.status) {
    return res.status(err.status).json({
      error: err.status >= 500 ? 'betel_api_error' : 'request_error',
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

function loadBillingRules() {
  return loadJsonFile('billing-rules.json');
}

function loadProposalRules() {
  return loadJsonFile('proposal-rules.json');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
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
  return err;
}

function parseMoney(value, fieldName) {
  if (value === undefined || value === null || value === '') return 0;
  const normalized = String(value).trim().replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw requestError(`${fieldName} deve ser numerico`, { field: fieldName, value });
  return parsed;
}

function proposalTotal(products) {
  if (!Array.isArray(products) || products.length === 0) {
    throw requestError('produtos deve conter pelo menos um item', { field: 'produtos' });
  }

  return products.reduce((total, item, index) => {
    const product = item?.produto || {};
    const quantity = parseMoney(product.quantidade ?? 1, `produtos[${index}].produto.quantidade`);
    const unitPrice = parseMoney(product.valor_venda, `produtos[${index}].produto.valor_venda`);
    return total + quantity * unitPrice;
  }, 0);
}

function formatProposalMoney(value, currency) {
  const number = Number(value || 0);
  if (currency === 'USD') return `US$ ${number.toFixed(2)}`;
  return `R$ ${number.toFixed(2)}`;
}

function buildProposalIntroduction(body) {
  const rules = loadProposalRules();
  const typeKey = normalizeText(body.tipo_proposta);
  const typeRule = rules.types?.[typeKey];

  if (!typeRule) {
    throw requestError('tipo_proposta invalido', {
      field: 'tipo_proposta',
      allowed: Object.keys(rules.types || {})
    });
  }

  const solution = String(body.solucao || '').trim();
  if (!solution) throw requestError('solucao e obrigatoria', { field: 'solucao' });

  let months = null;
  if (typeRule.requires_months) {
    months = Number(body.meses);
    if (!Number.isInteger(months) || months <= 0) {
      throw requestError('meses deve ser um inteiro maior que zero para este tipo de proposta', { field: 'meses' });
    }
  }

  const currency = String(body.moeda || rules.currency_default || 'BRL').trim().toUpperCase();
  if (!['BRL', 'USD'].includes(currency)) {
    throw requestError('moeda invalida', { field: 'moeda', allowed: ['BRL', 'USD'] });
  }

  const total = proposalTotal(body.produtos);
  const formattedValue = formatProposalMoney(total, currency);
  let pattern;

  if (typeKey === 'compra') {
    pattern = currency === 'USD' ? typeRule.introduction_pattern_usd : typeRule.introduction_pattern_brl;
  } else {
    pattern = typeRule.introduction_pattern;
  }

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

function parseIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    const err = new Error(`${fieldName} deve estar no formato YYYY-MM-DD`);
    err.status = 400;
    err.data = { field: fieldName, expected_format: 'YYYY-MM-DD' };
    throw err;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    const err = new Error(`${fieldName} invalida`);
    err.status = 400;
    err.data = { field: fieldName };
    throw err;
  }
  return date;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nextWednesdayOnOrAfter(date) {
  const day = date.getUTCDay();
  const wednesday = 3;
  const delta = (wednesday - day + 7) % 7;
  return addDaysUtc(date, delta);
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'seta-erp-connector',
    configured: getMissingEnv().length === 0
  });
});

app.use('/erp', auth);

app.get('/erp/clientes', async (req, res) => {
  try { res.json(await betelRequest('/clientes', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.post('/erp/clientes', async (req, res) => {
  try { res.json(await betelRequest('/clientes', { method: 'POST', body: req.body })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/produtos', async (req, res) => {
  try { res.json(await betelRequest('/produtos', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/usuarios', async (req, res) => {
  try { res.json(await betelRequest('/usuarios', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/situacoes-orcamentos', async (req, res) => {
  try { res.json(await betelRequest('/situacoes_orcamentos', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/orcamentos', async (req, res) => {
  try { res.json(await betelRequest('/orcamentos', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/orcamentos/:id', async (req, res) => {
  try { res.json(await betelRequest(`/orcamentos/${encodeURIComponent(req.params.id)}`)); }
  catch (err) { handleError(err, res); }
});

app.post('/erp/orcamentos', async (req, res) => {
  try {
    const { introduction, metadata } = buildProposalIntroduction(req.body || {});
    const {
      tipo_proposta,
      solucao,
      meses,
      moeda,
      ...betelBody
    } = req.body || {};

    betelBody.introducao = introduction;
    const result = await betelRequest('/orcamentos', { method: 'POST', body: betelBody });
    return res.json({
      status: 'success',
      proposal: result,
      commercial: metadata,
      introducao_enviada: introduction
    });
  } catch (err) { handleError(err, res); }
});

app.get('/erp/recebimentos', async (req, res) => {
  try { res.json(await betelRequest('/recebimentos', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/recebimentos/:id', async (req, res) => {
  try { res.json(await betelRequest(`/recebimentos/${encodeURIComponent(req.params.id)}`)); }
  catch (err) { handleError(err, res); }
});

app.post('/erp/recebimentos', async (req, res) => {
  try { res.json(await betelRequest('/recebimentos', { method: 'POST', body: req.body })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/planos-contas', async (req, res) => {
  try { res.json(await betelRequest('/planos_contas', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/formas-pagamentos', async (req, res) => {
  try { res.json(await betelRequest('/formas_pagamentos', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/contas-bancarias', async (req, res) => {
  try { res.json(await betelRequest('/contas_bancarias', { query: req.query })); }
  catch (err) { handleError(err, res); }
});

app.get('/erp/regras-faturamento', (req, res) => {
  try {
    const rule = findBillingRule({ cliente: req.query.cliente, cliente_id: req.query.cliente_id });
    if (!rule) {
      return res.status(404).json({
        error: 'billing_rule_not_found',
        message: 'Nenhuma regra de faturamento cadastrada para este cliente.'
      });
    }
    return res.json({ status: 'success', data: rule });
  } catch (err) {
    return handleError(err, res);
  }
});

app.post('/erp/regras-faturamento/calcular', (req, res) => {
  try {
    const { cliente, cliente_id, vencimento_anterior, data_edicao } = req.body || {};
    const rule = findBillingRule({ cliente, cliente_id });
    if (!rule) {
      return res.status(404).json({
        error: 'billing_rule_not_found',
        message: 'Nenhuma regra de faturamento cadastrada para este cliente.'
      });
    }

    const previousDue = parseIsoDate(vencimento_anterior, 'vencimento_anterior');
    parseIsoDate(data_edicao, 'data_edicao');

    if (rule.vencimento.base !== 'vencimento_fatura_anterior') {
      return res.status(400).json({ error: 'unsupported_billing_rule', message: 'Base de vencimento ainda nao suportada pelo calculador.' });
    }

    const minimumDate = addDaysUtc(previousDue, Number(rule.vencimento.dias_minimos || 0));
    let dueDate = minimumDate;

    if (rule.vencimento.ajuste_dia_semana === 'quarta-feira' && rule.vencimento.regra_ajuste === 'primeira_quarta_igual_ou_posterior') {
      dueDate = nextWednesdayOnOrAfter(minimumDate);
    }

    return res.json({
      status: 'success',
      data: {
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
      }
    });
  } catch (err) {
    return handleError(err, res);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Seta ERP Connector listening on 0.0.0.0:${PORT}`);
});
