import express from 'express';

const originalUse = express.application.use;
const originalPost = express.application.post;
let routeInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

function authorized(req) {
  return Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);
}

function configured() {
  return Boolean(BETEL_ACCESS_TOKEN && BETEL_SECRET_ACCESS_TOKEN);
}

async function betel(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BETEL_BASE_URL}${path}`, {
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
  return { ok: response.ok, status: response.status, data };
}

function compactDetails(value, maxLength = 3000) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...`;
  try { return JSON.parse(text); } catch { return text; }
}

function productVerificationQuery(payload) {
  const codigo = String(payload?.codigo_interno ?? payload?.codigo ?? '').trim();
  const nome = String(payload?.nome ?? payload?.descricao ?? '').trim();
  if (codigo) return `codigo_interno=${encodeURIComponent(codigo)}`;
  if (nome) return `nome=${encodeURIComponent(nome)}`;
  return null;
}

async function createProductHandler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ status: 'error', stage: 'authentication', write_attempted: false, message: 'unauthorized' });
  }
  if (!configured()) {
    return res.status(503).json({ status: 'error', stage: 'configuration', write_attempted: false, message: 'Credenciais Betel nao configuradas.' });
  }

  const body = req.body || {};
  if (body.confirmacao_criacao !== true) {
    return res.status(400).json({ status: 'error', stage: 'confirmation', write_attempted: false, message: 'confirmacao_criacao deve ser true apos preview e confirmacao explicita.' });
  }
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) || Object.keys(body.payload).length === 0) {
    return res.status(400).json({ status: 'error', stage: 'validation', write_attempted: false, message: 'payload do produto deve ser um objeto nao vazio.' });
  }

  let write;
  try {
    write = await betel('/produtos', { method: 'POST', body: body.payload });
  } catch (err) {
    return res.status(502).json({ status: 'error', stage: 'betel_create_transport', write_attempted: true, write_succeeded: false, message: err.message });
  }

  if (!write.ok) {
    return res.status(write.status).json({
      status: 'error',
      stage: 'betel_create',
      write_attempted: true,
      write_succeeded: false,
      betel_http_status: write.status,
      betel_details: compactDetails(write.data)
    });
  }

  const query = productVerificationQuery(body.payload);
  if (!query) {
    return res.status(200).json({
      status: 'success_unverified',
      write_attempted: true,
      write_succeeded: true,
      verification_succeeded: false,
      product: write.data,
      message: 'Produto criado, mas o payload nao continha nome/codigo_interno suficiente para verificacao automatica.'
    });
  }

  let verification;
  try {
    verification = await betel(`/produtos?${query}`);
  } catch (err) {
    return res.status(200).json({
      status: 'success_unverified',
      write_attempted: true,
      write_succeeded: true,
      verification_succeeded: false,
      product: write.data,
      message: err.message
    });
  }

  return res.status(200).json({
    status: verification.ok ? 'success' : 'success_unverified',
    write_attempted: true,
    write_succeeded: true,
    verification_succeeded: verification.ok,
    product: write.data,
    verification: compactDetails(verification.data),
    connector_write_mode: 'guarded_direct_betel_product_create'
  });
}

express.application.use = function patchedProductWriteUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!routeInstalled && proxyFn?.name === 'proxyToLegacy') {
    routeInstalled = true;
    originalPost.call(this, '/erp/produtos', createProductHandler);
    console.log('Installed guarded product creation route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
