import express from 'express';
import { randomUUID } from 'node:crypto';

const originalUse = express.application.use;
const originalGet = express.application.get;
let routeInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const READ_TIMEOUT_MS = 6500;
const READ_MAX_ATTEMPTS = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compactDetails(value, maxLength = 2000) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...`;
  try { return JSON.parse(text); } catch { return text; }
}

function extractProposalData(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
  return payload && typeof payload === 'object' ? payload : null;
}

function collectionFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'dados', 'results', 'orcamentos', 'items', 'registros']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function findProposalByNumber(payload, numero) {
  const target = String(numero);
  const list = collectionFromPayload(payload);
  const match = list.find(item => String(item?.codigo ?? item?.numero ?? item?.numero_proposta ?? item?.codigo_orcamento ?? '') === target);
  if (match) return match;
  const single = extractProposalData(payload);
  if (single && typeof single === 'object') {
    const value = single.codigo ?? single.numero ?? single.numero_proposta ?? single.codigo_orcamento;
    if (String(value ?? '') === target) return single;
  }
  return null;
}

async function resilientBetelGet(path) {
  let lastError = null;
  for (let attempt = 1; attempt <= READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${BETEL_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          'access-token': BETEL_ACCESS_TOKEN,
          'secret-access-token': BETEL_SECRET_ACCESS_TOKEN,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS)
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      return { ok: response.ok, status: response.status, data, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < READ_MAX_ATTEMPTS) await sleep(300 * attempt);
    }
  }
  const error = new Error(`Falha de transporte Betel apos ${READ_MAX_ATTEMPTS} tentativas: ${lastError?.message || 'erro desconhecido'}`);
  error.attempts = READ_MAX_ATTEMPTS;
  throw error;
}

async function resilientReadByNumberHandler(req, res) {
  const requestId = randomUUID();
  const numero = String(req.params.numero || '').trim();

  if (!CONNECTOR_API_KEY || req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) {
    return res.status(200).json({ status: 'error', stage: 'authentication', read_attempted: false, read_succeeded: false, numero, request_id: requestId, message: 'unauthorized' });
  }
  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN) {
    return res.status(200).json({ status: 'error', stage: 'configuration', read_attempted: false, read_succeeded: false, numero, request_id: requestId, message: 'Credenciais Betel nao configuradas no Railway.' });
  }
  if (!/^\d+$/.test(numero)) {
    return res.status(200).json({ status: 'error', stage: 'validation', read_attempted: false, read_succeeded: false, numero, request_id: requestId, message: 'numero da proposta deve ser numerico' });
  }

  let listResponse;
  try {
    listResponse = await resilientBetelGet(`/orcamentos?codigo=${encodeURIComponent(numero)}`);
  } catch (err) {
    return res.status(200).json({ status: 'error', stage: 'resolve_number_transport', read_attempted: true, read_succeeded: false, numero, request_id: requestId, betel_attempts: err.attempts || READ_MAX_ATTEMPTS, message: err.message });
  }
  if (!listResponse.ok) {
    return res.status(200).json({ status: 'error', stage: 'resolve_number', read_attempted: true, read_succeeded: false, numero, request_id: requestId, betel_attempts: listResponse.attempts, betel_http_status: listResponse.status, betel_details: compactDetails(listResponse.data) });
  }

  const summary = findProposalByNumber(listResponse.data, numero);
  const internalId = String(summary?.id ?? summary?.orcamento_id ?? summary?.id_orcamento ?? '').trim();
  if (!summary || !internalId) {
    return res.status(200).json({ status: 'not_found', stage: 'resolve_number', read_attempted: true, read_succeeded: false, numero, request_id: requestId, betel_attempts: listResponse.attempts, message: 'Proposta nao encontrada pelo numero comercial ou resposta sem ID interno.' });
  }

  let detailResponse;
  try {
    detailResponse = await resilientBetelGet(`/orcamentos/${encodeURIComponent(internalId)}`);
  } catch (err) {
    return res.status(200).json({ status: 'error', stage: 'load_resolved_proposal_transport', read_attempted: true, read_succeeded: false, numero, request_id: requestId, resolved_id: internalId, betel_attempts: err.attempts || READ_MAX_ATTEMPTS, message: err.message });
  }
  if (!detailResponse.ok) {
    return res.status(200).json({ status: 'error', stage: 'load_resolved_proposal', read_attempted: true, read_succeeded: false, numero, request_id: requestId, resolved_id: internalId, betel_attempts: detailResponse.attempts, betel_http_status: detailResponse.status, betel_details: compactDetails(detailResponse.data) });
  }

  const proposal = extractProposalData(detailResponse.data);
  if (String(proposal?.codigo ?? '') !== numero) {
    return res.status(200).json({ status: 'error', stage: 'identity_mismatch', read_attempted: true, read_succeeded: false, numero, request_id: requestId, resolved_id: internalId, codigo_retornado: proposal?.codigo ?? null, message: 'O ID resolvido nao corresponde ao numero comercial solicitado.' });
  }

  return res.status(200).json({
    status: 'success',
    stage: 'completed',
    read_attempted: true,
    read_succeeded: true,
    numero,
    id: internalId,
    codigo: proposal?.codigo ?? numero,
    nome_cliente: proposal?.nome_cliente ?? null,
    cliente_id: proposal?.cliente_id ?? null,
    valor_total: proposal?.valor_total ?? null,
    data: proposal?.data ?? null,
    validade: proposal?.validade ?? null,
    previsao_entrega: proposal?.previsao_entrega ?? null,
    prazo_entrega: proposal?.prazo_entrega ?? null,
    situacao_id: proposal?.situacao_id ?? null,
    nome_situacao: proposal?.nome_situacao ?? null,
    hash: proposal?.hash ?? null,
    request_id: requestId,
    betel_list_attempts: listResponse.attempts,
    betel_detail_attempts: detailResponse.attempts,
    connector_read_mode: 'resilient_betel_number_resolution'
  });
}

express.application.use = function patchedResilientReadUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!routeInstalled && proxyFn?.name === 'proxyToLegacy') {
    routeInstalled = true;
    originalGet.call(this, '/erp/orcamentos/numero/:numero', resilientReadByNumberHandler);
    console.log('Installed resilient proposal lookup by commercial number before legacy proxy');
  }
  return originalUse.apply(this, args);
};
