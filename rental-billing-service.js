import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const app = express();
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.RENTAL_BILLING_PORT || process.env.PORT || 3100;
const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const RENTAL_BILLING_API_KEY = process.env.RENTAL_BILLING_API_KEY;
const LEDGER_PATH = process.env.RENTAL_BILLING_LEDGER_PATH || path.resolve('data/rental-billing-ledger.json');
const BILLING_RULES_PATH = process.env.RENTAL_BILLING_RULES_PATH || path.resolve('billing-rules.json');
const LEDGER_LOCK_PATH = `${LEDGER_PATH}.lock`;
const BETEL_TIMEOUT_MS = Math.max(1000, Math.min(Number(process.env.RENTAL_BILLING_UPSTREAM_TIMEOUT_MS) || 15000, 60000));

function writesEnabled() {
  return process.env.RENTAL_BILLING_WRITES_ENABLED === 'true' && process.env.RENTAL_BILLING_KILL_SWITCH !== 'true';
}

function emissionEnabled() {
  return writesEnabled() && process.env.RENTAL_BILLING_EMISSION_ENABLED === 'true';
}

function assertWritesEnabled() {
  if (process.env.RENTAL_BILLING_KILL_SWITCH === 'true') {
    const error = requestError('kill switch ativo; gravacoes bloqueadas');
    error.status = 503;
    throw error;
  }
  if (!writesEnabled()) {
    const error = requestError('gravacoes de faturamento desabilitadas');
    error.status = 503;
    throw error;
  }
}

function assertEmissionEnabled() {
  assertWritesEnabled();
  if (!emissionEnabled()) {
    const error = requestError('emissao de NFS-e desabilitada');
    error.status = 503;
    throw error;
  }
}

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

async function readBillingRules() {
  const rules = JSON.parse(await fs.readFile(BILLING_RULES_PATH, 'utf8'));
  if (!Array.isArray(rules?.clients)) throw new Error('billing-rules.json invalido');
  return rules;
}

function parseIsoDate(value, field) {
  isoDate(value, field);
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nextOrSameWeekday(value, weekday) {
  const result = new Date(value);
  const delta = (weekday - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + delta);
  return result;
}

async function calculateBillingRule(body) {
  const clientKey = String(required(body?.cliente_regra, 'cliente_regra')).trim().toLowerCase();
  const rules = await readBillingRules();
  const rule = rules.clients.find(item => item.ativo === true && (
    String(item.key).toLowerCase() === clientKey ||
    item.aliases?.some(alias => String(alias).toLowerCase() === clientKey)
  ));
  if (!rule) throw requestError('regra de faturamento ativa nao encontrada', { cliente_regra: body.cliente_regra });

  const previousDueDate = parseIsoDate(body?.vencimento_fatura_anterior, 'vencimento_fatura_anterior');
  const editDate = parseIsoDate(body?.data_edicao, 'data_edicao');
  const minimumDays = Number(rule.vencimento?.dias_minimos);
  if (!Number.isInteger(minimumDays) || minimumDays < 0) throw new Error(`regra ${rule.key} possui dias_minimos invalido`);

  const minimumDueDate = addUtcDays(previousDueDate, minimumDays);
  let dueDate = minimumDueDate;
  if (rule.vencimento?.ajuste_dia_semana === 'quarta-feira' && rule.vencimento?.regra_ajuste === 'primeira_quarta_igual_ou_posterior') {
    dueDate = nextOrSameWeekday(minimumDueDate, 3);
  }
  if (rule.vencimento?.nunca_antecipar === true && dueDate < minimumDueDate) throw new Error(`regra ${rule.key} antecipou o vencimento`);

  return {
    status: 'calculated',
    write_attempted: false,
    cliente_regra: rule.key,
    data_emissao: rule.emissao?.base === 'data_edicao' ? formatIsoDate(editDate) : null,
    vencimento_fatura_anterior: formatIsoDate(previousDueDate),
    vencimento_minimo: formatIsoDate(minimumDueDate),
    data_vencimento: formatIsoDate(dueDate),
    dias_minimos: minimumDays,
    workflow: rule.workflow,
    regra_versao: rules.version
  };
}

function cleanQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') params.append(key, String(value));
  }
  return params.toString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(body) {
  const copy = structuredClone(body);
  delete copy.confirmacao_gravacao;
  delete copy.confirmacao_emissao;
  return crypto.createHash('sha256').update(stableJson(copy)).digest('hex');
}

async function readLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(LEDGER_PATH, 'utf8'));
    if (parsed?.version !== 1 || !parsed.records || typeof parsed.records !== 'object') throw new Error('formato de ledger invalido');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, records: {} };
    throw error;
  }
}

async function acquireLedgerLock() {
  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await fs.open(LEDGER_LOCK_PATH, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) {
        const lockError = new Error('ledger indisponivel para operacao atomica');
        lockError.status = 503;
        lockError.details = { cause: error.code };
        throw lockError;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function mutateLedger(mutator) {
  const lock = await acquireLedgerLock();
  const temporaryPath = `${LEDGER_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const ledger = await readLedger();
    const result = await mutator(ledger);
    await fs.writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, LEDGER_PATH);
    return result;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await lock.close().catch(() => {});
    await fs.rm(LEDGER_LOCK_PATH, { force: true }).catch(() => {});
  }
}

async function ledgerRecord(key) {
  return (await readLedger()).records[key] || null;
}

async function reserveExecution(body) {
  const hash = payloadHash(body);
  return mutateLedger(ledger => {
    const current = ledger.records[body.idempotency_key];
    if (current && current.payload_hash !== hash) {
      const error = requestError('idempotency_key reutilizada com payload diferente');
      error.status = 409;
      throw error;
    }
    if (current) return { record: current, resumed: true };
    const now = new Date().toISOString();
    const record = {
      idempotency_key: body.idempotency_key,
      contrato_id: String(body.contrato_id),
      cliente_id: String(body.recebimento.cliente_id),
      competencia: body.recebimento.data_competencia.slice(0, 7),
      payload_hash: hash,
      state: 'reserved',
      receipt_id: null,
      nfse_id: null,
      created_at: now,
      updated_at: now,
      last_error: null
    };
    ledger.records[body.idempotency_key] = record;
    return { record, resumed: false };
  });
}

async function transitionExecution(key, expectedStates, patch) {
  return mutateLedger(ledger => {
    const current = ledger.records[key];
    if (!current) throw requestError('execucao nao reservada no ledger');
    if (!expectedStates.includes(current.state)) {
      const error = requestError(`transicao invalida a partir de ${current.state}`);
      error.status = 409;
      throw error;
    }
    Object.assign(current, patch, { updated_at: new Date().toISOString() });
    return current;
  });
}

async function claimStep(key, expectedStates, inProgressState) {
  return transitionExecution(key, expectedStates, { state: inProgressState, last_error: null });
}

async function betel(path, { method = 'GET', query, body } = {}) {
  const qs = cleanQuery(query);
  const response = await fetch(`${BETEL_BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
    method,
    signal: AbortSignal.timeout(BETEL_TIMEOUT_MS),
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
  if (response.ok && data?.status !== 'error' && data?.data?.ok !== false) return data;
  const error = new Error(`Betel API error ${response.status}`);
  error.status = response.ok ? 502 : response.status;
  error.details = data;
  throw error;
}

async function betelAllPages(path, query = {}) {
  const firstPage = await betel(path, { query: { ...query, pagina: 1 } });
  const pages = Math.max(1, Number(firstPage?.meta?.total_paginas) || 1);
  if (pages > 1000) {
    const error = new Error('paginacao upstream excede limite de seguranca');
    error.status = 502;
    throw error;
  }
  if (pages === 1) return firstPage;
  const remaining = [];
  for (let page = 2; page <= pages; page += 1) remaining.push(await betel(path, { query: { ...query, pagina: page } }));
  return { ...firstPage, data: [ ...list(firstPage), ...remaining.flatMap(list) ] };
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
  const raw = String(required(value, field)).trim();
  let normalized = raw;
  if (raw.includes(',') && raw.includes('.')) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (raw.includes(',')) normalized = raw.replace(',', '.');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) throw requestError(`${field} possui formato monetario invalido`, { field });
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) throw requestError(`${field} deve ser maior que zero`, { field });
  return parsed;
}

function moneyCents(value, field) {
  return Math.round(money(value, field) * 100);
}

function marker(key) {
  required(key, 'idempotency_key');
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(String(key))) throw requestError('idempotency_key invalida', { field: 'idempotency_key' });
  return `[SETA-LOCACAO:${key}]`;
}

function validatePackage(body) {
  const receipt = body?.recebimento || {};
  const invoice = body?.nfse || {};
  required(body?.contrato_id, 'contrato_id');
  const idempotencyMarker = marker(body?.idempotency_key);
  for (const field of ['descricao', 'data_vencimento', 'plano_contas_id', 'forma_pagamento_id', 'conta_bancaria_id', 'valor', 'data_competencia', 'cliente_id']) required(receipt[field], `recebimento.${field}`);
  isoDate(receipt.data_vencimento, 'recebimento.data_vencimento');
  isoDate(receipt.data_competencia, 'recebimento.data_competencia');
  money(receipt.valor, 'recebimento.valor');
  for (const field of ['destinatario_id_cliente', 'valor_servico', 'codigo_atividade', 'codigo_natureza_operacao', 'iss_retido', 'cidade_incidencia_issqn', 'estado_incidencia_issqn', 'descricao']) required(invoice[field], `nfse.${field}`);
  money(invoice.valor_servico, 'nfse.valor_servico');
  if (String(receipt.cliente_id) !== String(invoice.destinatario_id_cliente)) throw requestError('Cliente do recebimento difere do destinatario da NFS-e');
  if (moneyCents(receipt.valor, 'recebimento.valor') !== moneyCents(invoice.valor_servico, 'nfse.valor_servico')) throw requestError('Valor do recebimento difere do valor da NFS-e');
  const expectedKeyPrefix = `${String(body.contrato_id)}:${receipt.data_competencia.slice(0, 7)}`;
  if (!String(body.idempotency_key).startsWith(expectedKeyPrefix)) throw requestError('idempotency_key deve vincular contrato e competencia', { expected_prefix: expectedKeyPrefix });
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
  const [receipts, invoices, localRecord] = await Promise.all([
    betel('/recebimentos', { query: { cliente_id: receipt.cliente_id, data_inicio: receipt.data_competencia, data_fim: receipt.data_competencia, limit: 100 } }),
    betelAllPages('/notas_fiscais_servicos', { limit: 100 }),
    ledgerRecord(body.idempotency_key)
  ]);
  const duplicateReceipts = list(receipts).filter(item => hasMarker(item, idempotencyMarker));
  const duplicateInvoices = list(invoices).filter(item => hasMarker(item, idempotencyMarker));
  const payloadMismatch = localRecord && localRecord.payload_hash !== payloadHash(body);
  const complete = localRecord && ['nfse_open', 'emitted', 'completed'].includes(localRecord.state);
  const receiptKnown = localRecord?.receipt_id && duplicateReceipts.some(item => String(item.id) === String(localRecord.receipt_id));
  const invoiceKnown = localRecord?.nfse_id && duplicateInvoices.some(item => String(item.id) === String(localRecord.nfse_id));
  const externallyDuplicated = duplicateReceipts.some(item => !receiptKnown || String(item.id) !== String(localRecord.receipt_id)) || duplicateInvoices.some(item => !invoiceKnown || String(item.id) !== String(localRecord.nfse_id));
  return {
    status: payloadMismatch || complete || externallyDuplicated ? 'duplicate_detected' : localRecord ? 'recoverable' : 'ready',
    write_attempted: false,
    can_write: !payloadMismatch && !complete && !externallyDuplicated,
    idempotency_key: body.idempotency_key,
    marker: idempotencyMarker,
    ledger: localRecord ? { state: localRecord.state, receipt_id: localRecord.receipt_id, nfse_id: localRecord.nfse_id, payload_match: !payloadMismatch } : null,
    duplicate_recebimentos: duplicateReceipts,
    duplicate_nfse: duplicateInvoices,
    execution_plan: ['create_recebimento', 'create_nfse_open', ...(body.emitir_nfse === true ? ['emit_nfse'] : [])]
  };
}

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'seta-rental-billing',
  version: '2.1.0-isolated',
  writes_enabled: writesEnabled(),
  emission_enabled: emissionEnabled(),
  kill_switch_active: process.env.RENTAL_BILLING_KILL_SWITCH === 'true'
}));
app.use(auth);

app.post('/erp/locacoes/faturamento/calcular-regra', async (req, res) => {
  try { res.json(await calculateBillingRule(req.body || {})); } catch (error) { handleError(error, res); }
});

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
    assertWritesEnabled();
    if (body.confirmacao_gravacao !== true) throw requestError('confirmacao_gravacao deve ser true');
    if (body.emitir_nfse === true && body.confirmacao_emissao !== true) throw requestError('confirmacao_emissao deve ser true quando emitir_nfse for true');
    if (body.emitir_nfse === true) assertEmissionEnabled();
    const check = await preflight(body);
    if (!check.can_write) return res.status(409).json({ ...check, message: 'Faturamento duplicado; nenhuma gravacao executada.' });
    const { receipt, invoice, idempotencyMarker } = validatePackage(body);
    const steps = [];
    let { record, resumed } = await reserveExecution(body);
    if (record.state.endsWith('_in_progress') || record.state.endsWith('_unknown')) {
      const error = requestError(`execucao concorrente em andamento: ${record.state}`);
      error.status = 409;
      throw error;
    }
    if (['nfse_open', 'emitted', 'completed'].includes(record.state)) {
      const error = requestError(`faturamento ja processado: ${record.state}`);
      error.status = 409;
      throw error;
    }

    if (['reserved', 'receipt_failed'].includes(record.state)) {
      try {
        record = await claimStep(body.idempotency_key, ['reserved', 'receipt_failed'], 'receipt_in_progress');
        const receiptResult = await betel('/recebimentos', { method: 'POST', body: { ...receipt, descricao: withMarker(receipt.descricao, idempotencyMarker) } });
        const receiptId = receiptResult?.data?.id || receiptResult?.id;
        if (!receiptId) throw new Error('ERP nao retornou o ID do recebimento');
        record = await transitionExecution(body.idempotency_key, ['receipt_in_progress'], { state: 'receipt_created', receipt_id: String(receiptId), last_error: null });
        steps.push({ step: 'create_recebimento', status: 'success', id: String(receiptId), data: receiptResult });
      } catch (error) {
        const state = error.status ? 'receipt_failed' : 'receipt_unknown';
        await transitionExecution(body.idempotency_key, ['receipt_in_progress'], { state, last_error: { step: 'create_recebimento', message: error.message, details: error.details || null } }).catch(() => {});
        return res.status(error.status || 502).json({ status: 'partial_failure', resumed, ledger_state: state, steps: [{ step: 'create_recebimento', status: 'failed', details: error.details }], next_action: state === 'receipt_unknown' ? 'reconcile_receipt_read_only_before_retry' : 'retry_same_idempotency_key' });
      }
    } else if (record.receipt_id) {
      steps.push({ step: 'create_recebimento', status: 'recovered', id: record.receipt_id });
    }

    if (['receipt_created', 'nfse_failed'].includes(record.state)) {
      try {
        record = await claimStep(body.idempotency_key, ['receipt_created', 'nfse_failed'], 'nfse_in_progress');
        const invoiceResult = await betel('/notas_fiscais_servicos', { method: 'POST', body: { ...invoice, descricao: withMarker(invoice.descricao, idempotencyMarker), envio_automatico: 0 } });
        const invoiceId = invoiceResult?.data?.dados || invoiceResult?.data?.id || invoiceResult?.id;
        if (!invoiceId) throw new Error('ERP nao retornou o ID da NFS-e');
        record = await transitionExecution(body.idempotency_key, ['nfse_in_progress'], { state: 'nfse_open', nfse_id: String(invoiceId), last_error: null });
        steps.push({ step: 'create_nfse_open', status: 'success', id: String(invoiceId), data: invoiceResult });
      } catch (error) {
        const state = error.status ? 'nfse_failed' : 'nfse_unknown';
        await transitionExecution(body.idempotency_key, ['nfse_in_progress'], { state, last_error: { step: 'create_nfse_open', message: error.message, details: error.details || null } }).catch(() => {});
        return res.status(error.status || 502).json({ status: 'partial_failure', resumed, ledger_state: state, steps, failed_step: 'create_nfse_open', details: error.details, next_action: state === 'nfse_unknown' ? 'reconcile_nfse_read_only_before_retry' : 'retry_same_idempotency_key_receipt_will_not_repeat' });
      }
    } else if (record.nfse_id) {
      steps.push({ step: 'create_nfse_open', status: 'recovered', id: record.nfse_id });
    }

    if (body.emitir_nfse === true) {
      const invoiceId = record.nfse_id;
      try {
        record = await claimStep(body.idempotency_key, ['nfse_open', 'emission_failed'], 'emission_in_progress');
        const emitted = await betel(`/notas_fiscais_servicos/emitir/${encodeURIComponent(invoiceId)}`, { method: 'POST' });
        record = await transitionExecution(body.idempotency_key, ['emission_in_progress'], { state: 'emitted', last_error: null });
        steps.push({ step: 'emit_nfse', status: 'success', nfse_id: String(invoiceId), data: emitted });
      } catch (error) {
        const state = error.status ? 'emission_failed' : 'emission_unknown';
        await transitionExecution(body.idempotency_key, ['emission_in_progress'], { state, last_error: { step: 'emit_nfse', message: error.message, details: error.details || null } }).catch(() => {});
        return res.status(error.status || 502).json({ status: 'partial_failure', resumed, ledger_state: state, steps, failed_step: 'emit_nfse', nfse_id: String(invoiceId), next_action: state === 'emission_unknown' ? 'reconcile_emission_read_only_before_retry' : 'retry_emission_for_linked_nfse' });
      }
    }
    res.status(resumed ? 200 : 201).json({ status: 'success', resumed, ledger_state: record.state, idempotency_key: body.idempotency_key, steps, next_action: body.emitir_nfse ? 'billing_complete' : 'await_nfse_emission_policy' });
  } catch (error) { handleError(error, res); }
});

app.post('/erp/notas-fiscais-servicos/:id/emitir', async (req, res) => {
  try {
    assertEmissionEnabled();
    if (req.body?.confirmacao_emissao !== true) throw requestError('confirmacao_emissao deve ser true');
    const key = required(req.body?.idempotency_key, 'idempotency_key');
    const record = await ledgerRecord(key);
    if (!record || String(record.nfse_id) !== String(req.params.id)) {
      const error = requestError('NFS-e nao vinculada a esta execucao');
      error.status = 409;
      throw error;
    }
    if (!['nfse_open', 'emission_failed'].includes(record.state)) {
      const error = requestError(`NFS-e nao pode ser emitida no estado ${record.state}`);
      error.status = 409;
      throw error;
    }
    try {
      await claimStep(key, ['nfse_open', 'emission_failed'], 'emission_in_progress');
      const emitted = await betel(`/notas_fiscais_servicos/emitir/${encodeURIComponent(req.params.id)}`, { method: 'POST' });
      await transitionExecution(key, ['emission_in_progress'], { state: 'emitted', last_error: null });
      res.json({ status: 'success', idempotency_key: key, nfse_id: String(req.params.id), data: emitted });
    } catch (error) {
      const state = error.status ? 'emission_failed' : 'emission_unknown';
      await transitionExecution(key, ['emission_in_progress'], { state, last_error: { step: 'emit_nfse', message: error.message, details: error.details || null } }).catch(() => {});
      throw error;
    }
  } catch (error) { handleError(error, res); }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Seta Rental Billing listening on 0.0.0.0:${PORT}`));
}
