import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_CONNECTOR_PORT || 3001);
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

function auth(req, res, next) {
  if (!CONNECTOR_API_KEY) return res.status(503).json({ error: 'connector_not_configured', missing: ['CONNECTOR_API_KEY'] });
  if (req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requestError(message, details = {}) {
  const err = new Error(message);
  err.status = 400;
  err.source = 'request';
  err.data = details;
  return err;
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
  return res.status(500).json({ error: 'gateway_error', message: err.message });
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
  err.source = 'hubspot';
  err.data = data;
  throw err;
}

function normalizeRecipient(value, index) {
  const email = String(value?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw requestError(`destinatarios[${index}].email invalido`, { field: `destinatarios[${index}].email` });
  return {
    email,
    firstName: String(value?.firstName || value?.firstname || value?.nome || '').trim(),
    lastName: String(value?.lastName || value?.lastname || value?.sobrenome || '').trim()
  };
}

function normalizeOptionalRecipients(values, fieldName) {
  if (!values) return [];
  if (!Array.isArray(values)) throw requestError(`${fieldName} deve ser uma lista`, { field: fieldName });
  return values.map((item, index) => normalizeRecipient(item, `${fieldName}.${index}`));
}

function loadProposalRules() {
  const fileUrl = new URL('./proposal-rules.json', import.meta.url);
  return JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
}

async function associateEmail(emailId, objectType, objectId) {
  if (!objectId) return null;
  return hubspotRequest(`/crm/v4/objects/emails/${encodeURIComponent(emailId)}/associations/default/${objectType}/${encodeURIComponent(objectId)}`, { method: 'PUT' });
}

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'seta-erp-connector',
    gateway: true,
    hubspot_configured: Boolean(HUBSPOT_ACCESS_TOKEN),
    connector_configured: Boolean(CONNECTOR_API_KEY)
  });
});

app.post('/erp/hubspot/emails/registrar-envio', auth, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.envio_confirmado !== true) {
      throw requestError('envio_confirmado deve ser true. Esta rota registra apenas e-mails realmente enviados pelo Outlook.', { field: 'envio_confirmado' });
    }

    const remetenteEmail = String(body.remetente?.email || body.remetente_email || '').trim().toLowerCase();
    if (!remetenteEmail || !remetenteEmail.includes('@')) throw requestError('remetente.email e obrigatorio', { field: 'remetente.email' });

    if (!Array.isArray(body.destinatarios) || body.destinatarios.length === 0) {
      throw requestError('destinatarios deve conter pelo menos um destinatario', { field: 'destinatarios' });
    }
    if (body.destinatarios.length > 10) throw requestError('destinatarios aceita no maximo 10 itens', { field: 'destinatarios' });

    const destinatarios = body.destinatarios.map((item, index) => normalizeRecipient(item, index));
    const cc = normalizeOptionalRecipients(body.cc, 'cc');
    const bcc = normalizeOptionalRecipients(body.bcc, 'bcc');
    const assunto = String(body.assunto || '').trim();
    const texto = String(body.texto || '').trim();
    if (!assunto) throw requestError('assunto e obrigatorio', { field: 'assunto' });
    if (!texto) throw requestError('texto e obrigatorio', { field: 'texto' });

    const timestamp = body.enviado_em ? new Date(body.enviado_em) : new Date();
    if (Number.isNaN(timestamp.getTime())) throw requestError('enviado_em deve ser uma data/hora ISO valida', { field: 'enviado_em' });

    const headers = {
      from: {
        email: remetenteEmail,
        firstName: String(body.remetente?.firstName || body.remetente?.firstname || body.remetente?.nome || '').trim(),
        lastName: String(body.remetente?.lastName || body.remetente?.lastname || body.remetente?.sobrenome || '').trim()
      },
      sender: {
        email: remetenteEmail,
        firstName: String(body.remetente?.firstName || body.remetente?.firstname || body.remetente?.nome || '').trim(),
        lastName: String(body.remetente?.lastName || body.remetente?.lastname || body.remetente?.sobrenome || '').trim()
      },
      to: destinatarios,
      cc,
      bcc
    };

    const properties = {
      hs_timestamp: timestamp.toISOString(),
      hs_email_direction: 'EMAIL',
      hs_email_status: 'SENT',
      hs_email_subject: assunto,
      hs_email_text: texto,
      hs_email_headers: JSON.stringify(headers)
    };
    if (body.hubspot_owner_id) properties.hubspot_owner_id = String(body.hubspot_owner_id);

    const email = await hubspotRequest('/crm/v3/objects/emails', {
      method: 'POST',
      body: { properties }
    });

    const associationResults = [];
    const associationFailures = [];
    const targets = [
      body.deal_id ? { type: 'deals', id: body.deal_id } : null,
      body.company_id ? { type: 'companies', id: body.company_id } : null,
      ...(Array.isArray(body.contact_ids) ? body.contact_ids.map(id => ({ type: 'contacts', id })) : [])
    ].filter(Boolean);

    for (const target of targets) {
      try {
        await associateEmail(email.id, target.type, target.id);
        associationResults.push(target);
      } catch (err) {
        associationFailures.push({ target, status: err.status || 500, details: err.data || err.message });
      }
    }

    let dealStageUpdate = null;
    if (body.atualizar_etapa === true) {
      if (!body.deal_id) throw requestError('deal_id e obrigatorio quando atualizar_etapa=true', { field: 'deal_id' });
      const tipo = String(body.tipo_proposta || '').trim().toLowerCase();
      const rules = loadProposalRules();
      const typeRule = rules.types?.[tipo];
      if (!typeRule) throw requestError('tipo_proposta invalido para atualizar a etapa', { field: 'tipo_proposta', allowed: Object.keys(rules.types || {}) });
      dealStageUpdate = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(body.deal_id)}`, {
        method: 'PATCH',
        body: { properties: { dealstage: typeRule.hubspot_stage_proposta_enviada } }
      });
    }

    res.status(201).json({
      status: associationFailures.length ? 'partial_success' : 'success',
      email: {
        id: email.id,
        subject: assunto,
        status: 'SENT',
        direction: 'EMAIL',
        timestamp: timestamp.toISOString(),
        outlook_message_id: body.outlook_message_id || null
      },
      associations: associationResults,
      association_failures: associationFailures,
      deal_stage_updated: Boolean(dealStageUpdate),
      deal: dealStageUpdate
    });
  } catch (err) {
    handleError(err, res);
  }
});

async function proxyToLegacy(req, res) {
  try {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'content-length', 'connection'].includes(key.toLowerCase())) continue;
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(',') : String(value);
    }

    let body;
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      body = req.body === undefined ? undefined : JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${req.originalUrl}`, {
      method: req.method,
      headers,
      body
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'legacy_connector_unavailable', message: err.message });
  }
}

app.use(proxyToLegacy);

const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  console.error(`Legacy connector exited code=${code} signal=${signal}`);
});

function shutdown(signal) {
  console.log(`Gateway received ${signal}`);
  if (!child.killed) child.kill(signal);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Seta ERP Gateway listening on 0.0.0.0:${PORT}; legacy connector on ${INTERNAL_PORT}`);
});
