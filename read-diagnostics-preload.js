import express from 'express';

const originalUse = express.application.use;
const originalGet = express.application.get;
let readRouteInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

function compactDetails(value, maxLength = 3000) {
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

async function directBetelGet(path) {
  const response = await fetch(`${BETEL_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'access-token': BETEL_ACCESS_TOKEN,
      'secret-access-token': BETEL_SECRET_ACCESS_TOKEN,
      Accept: 'application/json'
    }
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

async function directReadHandler(req, res) {
  const id = String(req.params.id || '').trim();

  if (!CONNECTOR_API_KEY || req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) {
    return res.status(200).json({
      status: 'error',
      stage: 'authentication',
      read_attempted: false,
      read_succeeded: false,
      message: 'unauthorized'
    });
  }

  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN) {
    return res.status(200).json({
      status: 'error',
      stage: 'configuration',
      read_attempted: false,
      read_succeeded: false,
      message: 'Credenciais Betel nao configuradas no Railway.'
    });
  }

  let result;
  try {
    result = await directBetelGet(`/orcamentos/${encodeURIComponent(id)}`);
  } catch (err) {
    return res.status(200).json({
      status: 'error',
      stage: 'betel_read_transport',
      read_attempted: true,
      read_succeeded: false,
      message: err.message
    });
  }

  if (!result.ok) {
    return res.status(200).json({
      status: 'error',
      stage: 'betel_read',
      read_attempted: true,
      read_succeeded: false,
      betel_http_status: result.status,
      betel_details: compactDetails(result.data)
    });
  }

  const proposal = extractProposalData(result.data);
  return res.status(200).json({
    status: 'success',
    stage: 'completed',
    read_attempted: true,
    read_succeeded: true,
    id,
    codigo: proposal?.codigo ?? null,
    data: proposal?.data ?? null,
    previsao_entrega: proposal?.previsao_entrega ?? null,
    prazo_entrega: proposal?.prazo_entrega ?? null,
    cliente_id: proposal?.cliente_id ?? null,
    situacao_id: proposal?.situacao_id ?? null,
    hash: proposal?.hash ?? null
  });
}

express.application.use = function patchedUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!readRouteInstalled && proxyFn?.name === 'proxyToLegacy') {
    readRouteInstalled = true;
    originalGet.call(this, '/erp/orcamentos/:id', directReadHandler);
    console.log('Installed direct Betel proposal read route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
