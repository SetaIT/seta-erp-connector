import express from 'express';

export const app = express();
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.RENTAL_BILLING_PORT || process.env.PORT || 3100;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const RENTAL_BILLING_API_KEY = process.env.RENTAL_BILLING_API_KEY;

function auth(req, res, next) {
  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN || !RENTAL_BILLING_API_KEY) {
    return res.status(503).json({ status: 'error', stage: 'configuration', write_attempted: false });
  }
  if (req.headers.authorization !== `Bearer ${RENTAL_BILLING_API_KEY}`) {
    return res.status(401).json({ status: 'error', stage: 'authentication', write_attempted: false });
  }
  next();
}

function requestError(message, details = {}) {
  const error = new Error(message);
  error.status = 400;
  error.details = details;
  return error;
}

function cleanQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') params.append(key, String(value));
  }
  return params.toString();
}

async function betel(path, { method = 'GET', query, body } = {}) {
  const qs = cleanQuery(query);
  const response = await fetch(`${BETEL_BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
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
  const error = new Error(`Betel API error ${response.status}`);
  error.status = response.status;
  error.details = data;
  throw error;
}

function handleError(error, res) {
  res.status(error.status || 500).json({
    status: 'error',
    message: error.message,
    details: error.details || null,
    write_attempted: false
  });
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') throw requestError(`${field} e obrigatorio`, { field });
  return value;
}

function isoDate(value, field) {
  required(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw requestError(`${field} deve usar YYYY-MM-DD`, { field });
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw requestError(`${field} invalida`, { field });
}

function money(value, field) {
  const normalized = String(required(value, field)).replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) throw requestError(`${field} deve ser maior que zero`, { field });
  return parsed;
}

function marker(key) {
  required(key, 'idempotency_key');
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(String(key))) throw requestError('idempotency_key invalida', { field: 'idempotency_key' });
  return `[SETA-LOCACAO:${key}]`;
}

function validatePackage(body) {
  const receipt = body?.recebimento || {};
  const invoice = body?.nfse || {};
  const idempotencyMarker = marker(body?.idempotency_key);
  for (const field of ['descricao', 'data_vencimento', 'plano_contas_id', 'forma_pagamento_id', 'conta_bancaria_id', 'valor', 'data_competencia', 'cliente_id']) required(receipt[field], `recebimento.${field}`);
  isoDate(receipt.data_vencimento, 'recebimento.data_vencimento');
  isoDate(receipt.data_competencia, 'recebimento.data_competencia');
  money(receipt.valor, 'recebimento.valor');
  for (const field of ['destinatario_id_cliente', 'valor_servico', 'codigo_atividade', 'codigo_natureza_operacao', 'iss_retido', 'cidade_incidencia_issqn', 'estado_incidencia_issqn', 'descricao']) required(invoice[field], `nfse.${field}`);
  money(invoice.valor_servico, 'nfse.valor_servico');
  if (String(receipt.cliente_id) !== String(invoice.destinatario_id_cliente)) throw requestError('Cliente do recebimento difere do destinatario da NFS-e');
  return { receipt, invoice, idempotencyMarker };
}

function list(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function hasMarker(item, value) {
  return ['descricao', 'observacao', 'observacoes', 'outras_informacoes'].some(field => String(item?.[field] || '').includes(value));
}

function withMarker(value, idempotencyMarker) {
  const text = String(value || '').trim();
  return text.includes(idempotencyMarker) ? text : `${text}${text ? ' ' : ''}${idempotencyMarker}`;
}

async function preflight(body) {
  const { receipt, idempotencyMarker } = validatePackage(body);
  const [receipts, invoices] = await Promise.all([
    betel('/recebimentos', { query: { cliente_id: receipt.cliente_id, data_inicio: receipt.data_competencia, data_fim: receipt.data_competencia, limit: 100 } }),
    betel('/notas_fiscais_servicos', { query: { pagina: 1, limit: 100 } })
  ]);
  const duplicateReceipts = list(receipts).filter(item => hasMarker(item, idempotencyMarker));
  const duplicateInvoices = list(invoices).filter(item => hasMarker(item, idempotencyMarker));
  return {
    status: duplicateReceipts.length || duplicateInvoices.length ? 'duplicate_detected' : 'ready',
    write_attempted: false,
    can_write: duplicateReceipts.length === 0 && duplicateInvoices.length === 0,
    idempotency_key: body.idempotency_key,
    marker: idempotencyMarker,
    duplicate_recebimentos: duplicateReceipts,
    duplicate_nfse: duplicateInvoices,
    execution_plan: ['create_recebimento', 'create_nfse_open', ...(body.emitir_nfse === true ? ['emit_nfse'] : [])]
  };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'seta-rental-billing', version: '2.0.0-isolated', writes_enabled: true }));
app.use(auth);

app.post('/erp/locacoes/faturamento/preflight', async (req, res) => {
  try { res.json(await preflight(req.body || {})); } catch (error) { handleError(error, res); }
});

app.get('/erp/notas-fiscais-servicos', async (req, res) => {
  try { res.json(await betel('/notas_fiscais_servicos', { query: req.query })); } catch (error) { handleError(error, res); }
});

app.get('/erp/notas-fiscais-servicos/:id', async (req, res) => {
  try { res.json(await betel(`/notas_fiscais_servicos/${encodeURIComponent(req.params.id)}`)); } catch (error) { handleError(error, res); }
});

app.post('/erp/locacoes/faturamento/executar', async (req, res) => {
  const body = req.body || {};
  try {
    if (body.confirmacao_gravacao !== true) throw requestError('confirmacao_gravacao deve ser true');
    if (body.emitir_nfse === true && body.confirmacao_emissao !== true) throw requestError('confirmacao_emissao deve ser true quando emitir_nfse for true');
    const check = await preflight(body);
    if (!check.can_write) return res.status(409).json({ ...check, message: 'Faturamento duplicado; nenhuma gravacao executada.' });
    const { receipt, invoice, idempotencyMarker } = validatePackage(body);
    const steps = [];

    let receiptResult;
    try {
      receiptResult = await betel('/recebimentos', { method: 'POST', body: { ...receipt, descricao: withMarker(receipt.descricao, idempotencyMarker) } });
      steps.push({ step: 'create_recebimento', status: 'success', data: receiptResult });
    } catch (error) {
      return res.status(error.status || 502).json({ status: 'partial_failure', steps: [{ step: 'create_recebimento', status: 'failed', details: error.details }], next_action: 'review_recebimento_failure' });
    }

    let invoiceResult;
    try {
      invoiceResult = await betel('/notas_fiscais_servicos', { method: 'POST', body: { ...invoice, descricao: withMarker(invoice.descricao, idempotencyMarker), envio_automatico: 0 } });
      steps.push({ step: 'create_nfse_open', status: 'success', data: invoiceResult });
    } catch (error) {
      return res.status(error.status || 502).json({ status: 'partial_failure', steps, failed_step: 'create_nfse_open', details: error.details, next_action: 'review_nfse_failure_recebimento_already_created' });
    }

    if (body.emitir_nfse === true) {
      const invoiceId = invoiceResult?.data?.dados || invoiceResult?.data?.id || invoiceResult?.id;
      if (!invoiceId) return res.status(502).json({ status: 'partial_failure', steps, next_action: 'consult_nfse_before_emission' });
      try {
        const emitted = await betel(`/notas_fiscais_servicos/emitir/${encodeURIComponent(invoiceId)}`, { method: 'POST' });
        steps.push({ step: 'emit_nfse', status: 'success', nfse_id: String(invoiceId), data: emitted });
      } catch (error) {
        return res.status(error.status || 502).json({ status: 'partial_failure', steps, failed_step: 'emit_nfse', nfse_id: String(invoiceId), next_action: 'retry_nfse_emission_only' });
      }
    }
    res.status(201).json({ status: 'success', idempotency_key: body.idempotency_key, steps, next_action: body.emitir_nfse ? 'billing_complete' : 'await_nfse_emission_approval' });
  } catch (error) { handleError(error, res); }
});

app.post('/erp/notas-fiscais-servicos/:id/emitir', async (req, res) => {
  try {
    if (req.body?.confirmacao_emissao !== true) throw requestError('confirmacao_emissao deve ser true');
    res.json(await betel(`/notas_fiscais_servicos/emitir/${encodeURIComponent(req.params.id)}`, { method: 'POST' }));
  } catch (error) { handleError(error, res); }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Seta Rental Billing listening on 0.0.0.0:${PORT}`));
}
