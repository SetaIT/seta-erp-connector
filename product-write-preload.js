import express from 'express';

const originalUse = express.application.use;
const originalPost = express.application.post;
let routeInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const ERP_SUPERVISOR_BASE_URL = String(process.env.ERP_SUPERVISOR_BASE_URL || '').replace(/\/$/, '');
const ERP_SUPERVISOR_TOKEN = String(process.env.ERP_SUPERVISOR_TOKEN || '').trim();
const GESTAOCLICK_MCP_WRITES_ENABLED = String(process.env.GESTAOCLICK_MCP_WRITES_ENABLED || 'false').toLowerCase() === 'true';
const GESTAOCLICK_MCP_READS_ENABLED = String(process.env.GESTAOCLICK_MCP_READS_ENABLED || 'false').toLowerCase() === 'true';

function authorized(req) {
  return Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);
}

function configured() {
  if (GESTAOCLICK_MCP_WRITES_ENABLED) return Boolean(ERP_SUPERVISOR_BASE_URL && ERP_SUPERVISOR_TOKEN);
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

async function mcpProxy(path, payload, correlationId) {
  if (!ERP_SUPERVISOR_BASE_URL || !ERP_SUPERVISOR_TOKEN) throw new Error('ERP Supervisor MCP proxy is not configured');
  const response = await fetch(`${ERP_SUPERVISOR_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ERP_SUPERVISOR_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {})
    },
    body: JSON.stringify(payload)
  });
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok || envelope?.status !== 'ok') {
    const error = new Error(`MCP proxy failed with HTTP ${response.status}`);
    error.status = response.status;
    error.details = envelope;
    throw error;
  }
  const content = Array.isArray(envelope?.result?.content) ? envelope.result.content : [];
  const text = content.find(item => item?.type === 'text')?.text;
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: String(text).slice(0, 2000) }; }
  }
  return {
    ok: Number(parsed?.http_status || response.status || 200) < 400,
    status: Number(parsed?.http_status || response.status || 200),
    data: parsed?.resposta ?? parsed ?? envelope,
    source: 'gestaoclick_mcp'
  };
}

async function createProduct(payload, correlationId) {
  if (GESTAOCLICK_MCP_WRITES_ENABLED) {
    return mcpProxy('/mcp/gestaoclick/write', {
      recurso: 'produtos',
      acao: 'cadastrar',
      dados: payload,
      confirmar_escrita: true
    }, correlationId);
  }
  const response = await betel('/produtos', { method: 'POST', body: payload });
  return { ...response, source: 'betel' };
}

async function verifyProduct(payload) {
  const codigo = String(payload?.codigo_interno ?? payload?.codigo ?? '').trim();
  const nome = String(payload?.nome ?? payload?.descricao ?? '').trim();
  if (GESTAOCLICK_MCP_READS_ENABLED && (codigo || nome)) {
    try {
      const dados = codigo ? { codigo_interno: codigo, limite: 1 } : { nome, limite: 1 };
      return await mcpProxy('/mcp/gestaoclick/read', {
        recurso: 'produtos',
        acao: 'listar',
        dados
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'gestaoclick_mcp_product_verify_fallback',
        message: error?.message || String(error)
      }));
    }
  }
  const query = productVerificationQuery(payload);
  if (!query) return null;
  const response = await betel(`/produtos?${query}`);
  return { ...response, source: 'betel' };
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
  const correlationId = String(req.headers['x-correlation-id'] || '').trim() || undefined;
  try {
    write = await createProduct(body.payload, correlationId);
  } catch (err) {
    return res.status(502).json({
      status: GESTAOCLICK_MCP_WRITES_ENABLED ? 'write_outcome_unknown' : 'error',
      stage: GESTAOCLICK_MCP_WRITES_ENABLED ? 'mcp_create_transport' : 'betel_create_transport',
      write_attempted: true,
      write_succeeded: false,
      write_source: GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel',
      retry_safe: false,
      message: err.message
    });
  }

  if (!write.ok) {
    return res.status(write.status || 502).json({
      status: 'error',
      stage: GESTAOCLICK_MCP_WRITES_ENABLED ? 'mcp_create' : 'betel_create',
      write_attempted: true,
      write_succeeded: false,
      write_source: write.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
      upstream_http_status: write.status,
      upstream_details: compactDetails(write.data),
      retry_safe: false
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
      write_source: write.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
      message: 'Produto criado, mas o payload nao continha nome/codigo_interno suficiente para verificacao automatica.'
    });
  }

  let verification;
  try {
    verification = await verifyProduct(body.payload);
  } catch (err) {
    return res.status(200).json({
      status: 'success_unverified',
      write_attempted: true,
      write_succeeded: true,
      verification_succeeded: false,
      product: write.data,
      write_source: write.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
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
    write_source: write.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
    verification_source: verification?.source || 'betel',
    connector_write_mode: GESTAOCLICK_MCP_WRITES_ENABLED ? 'guarded_mcp_product_create' : 'guarded_direct_betel_product_create'
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
