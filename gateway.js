import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process';
import { correlationIdFrom, sanitizePayload, structuredLog } from './commercial-write-reconciliation.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const correlationId = correlationIdFrom(req.headers['x-correlation-id']);
  req.correlationId = correlationId;
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  structuredLog('connector_request_received', { correlation_id: correlationId, method: req.method, path: req.path });
  next();
});

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_CONNECTOR_PORT || 3001);
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const OUTLOOK_SENDER_EMAIL = String(process.env.OUTLOOK_SENDER_EMAIL || '').trim().toLowerCase();
const PROPOSAL_PUBLIC_BASE_URL = String(process.env.PROPOSAL_PUBLIC_BASE_URL || 'https://app.setatelecom.com.br/prop').replace(/\/$/, '');

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
      details: sanitizePayload(err.data),
      request_correlation_id: err.correlation_id || null,
      downstream_request_id: err.request_id || null,
      endpoint: err.endpoint || null,
      operation: err.operation || null,
      timestamp: err.timestamp || new Date().toISOString()
    });
  }
  return res.status(500).json({ error: 'gateway_error', message: err.message });
}

function diagnosticError(err) {
  return {
    status: err?.status || 500,
    source: err?.source || 'unknown',
    message: err?.message || 'Erro desconhecido',
    details: err?.data || null
  };
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

async function microsoftAccessToken() {
  const missing = [
    !MICROSOFT_TENANT_ID && 'MICROSOFT_TENANT_ID',
    !MICROSOFT_CLIENT_ID && 'MICROSOFT_CLIENT_ID',
    !MICROSOFT_CLIENT_SECRET && 'MICROSOFT_CLIENT_SECRET',
    !OUTLOOK_SENDER_EMAIL && 'OUTLOOK_SENDER_EMAIL'
  ].filter(Boolean);
  if (missing.length) {
    const err = new Error('Microsoft 365 nao configurado');
    err.status = 503;
    err.source = 'microsoft';
    err.data = { missing };
    throw err;
  }
  const body = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.access_token) return data.access_token;
  const err = new Error('Falha ao autenticar no Microsoft 365');
  err.status = response.status;
  err.source = 'microsoft';
  err.data = { error: data.error, error_description: data.error_description };
  throw err;
}

async function sendOutlookMail({ to, subject, html }) {
  const token = await microsoftAccessToken();
  const recipients = to.map(address => ({ emailAddress: { address } }));
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(OUTLOOK_SENDER_EMAIL)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients
      },
      saveToSentItems: true
    })
  });
  if (response.ok) return { request_id: response.headers.get('request-id') || response.headers.get('client-request-id') || null };
  const data = await response.json().catch(() => ({}));
  const err = new Error(data?.error?.message || `Microsoft Graph error ${response.status}`);
  err.status = response.status;
  err.source = 'microsoft';
  err.data = data;
  throw err;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function proposalEmailTemplate({ contactName, proposalTitle, proposalNumber, proposalLink, returnDate, customBody }) {
  const greeting = contactName ? `Olá ${escapeHtml(contactName)}, tudo bem?` : 'Olá, tudo bem?';
  const safeTitle = escapeHtml(proposalTitle || 'Sua Proposta Comercial');
  const safeNumber = escapeHtml(proposalNumber);
  const safeLink = escapeHtml(proposalLink);
  const returnLine = returnDate ? `Agradeço desde já pelo retorno no dia ${escapeHtml(returnDate)}.` : 'Agradeço desde já pelo retorno.';
  const message = String(customBody || 'Obrigado pela oportunidade.\n\nAbaixo o link da proposta conforme solicitado.\n\nQualquer dúvida estou à disposição.').trim();
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const text = `${proposalTitle || 'Sua Proposta Comercial'}\n\nN. ${proposalNumber}\n\n${contactName ? `Olá ${contactName}, tudo bem?` : 'Olá, tudo bem?'}\n\n${message}\n\nNúmero da Proposta: ${proposalNumber}\nLink da Proposta: ${proposalLink}\n\n${returnDate ? `Agradeço desde já pelo retorno no dia ${returnDate}.` : 'Agradeço desde já pelo retorno.'}\n\nConheça Nossos Serviços:\n- Soluções em Spare Part (Garantia Estendida)\n- Locação de Equipamentos de Rede\n- Locação de Notebooks\n- Locação de Servidores\n- Venda de Equipamentos Cisco Novos e Seminovos\n- Soluções de Videoconferência e Telefonia\n- Soluções de Backup na Nuvem\n- Cisco Smartnet\n\nQualquer dúvida estou à disposição!\n\nMarcéllo MMíra\nBusiness Consultant\nWhatsApp: +55 (11) 3958-4929\nsetatelecom.com.br`;
  const html = `<!doctype html><html><body style="margin:0;background:#ffffff;color:#172033;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55"><div style="max-width:700px;margin:0 auto;padding:24px"><img src="https://4369067.fs1.hubspotusercontent-na1.net/hubfs/4369067/azul-transparent-1.png" alt="Seta Telecom" style="display:block;max-width:220px;height:auto;margin:0 0 28px"><h1 style="font-size:24px;margin:0 0 4px">${safeTitle}</h1><h2 style="font-size:20px;margin:0 0 28px">N. ${safeNumber}</h2><p>${greeting}</p><p>${safeMessage}</p><p><strong>Número da Proposta: ${safeNumber}</strong></p><p><strong>Link da Proposta: </strong><a href="${safeLink}" style="color:#0754a6;font-weight:700">${safeLink}</a></p><p>${returnLine} Se preferir, pode me ligar ou me chamar no <a href="https://api.whatsapp.com/send?phone=551139584929&text=Ol%C3%A1,%20em%20que%20posso%20ajudar?" style="color:#0754a6;font-weight:700">WhatsApp</a>.</p><p><strong>Conheça Nossos Serviços:</strong></p><p>👉 Soluções em Spare Part (Garantia Estendida)<br>👉 Locação de Equipamentos de Rede<br>👉 Locação de Notebooks<br>👉 Locação de Servidores<br>👉 Venda de Equipamentos Cisco Novos e Seminovos<br>👉 Soluções de Videoconferência e Telefonia<br>👉 Soluções de Backup na Nuvem<br>👉 Cisco Smartnet</p><p>Qualquer dúvida estou à disposição!</p><p>Att,</p><table role="presentation" style="margin-top:24px;border-collapse:collapse"><tr><td style="padding-right:18px;vertical-align:top"><img src="https://f.hubspotusercontent10.net/hubfs/4369067/azul-transparent.png" alt="Seta Telecom" style="display:block;max-width:145px;height:auto"></td><td style="border-left:3px solid #0754a6;padding-left:18px"><strong>Marcéllo MMíra</strong><br>Business Consultant<br><a href="https://api.whatsapp.com/send?phone=551139584929&text=Ol%C3%A1,%20em%20que%20posso%20ajudar?" style="color:#0754a6">WhatsApp</a><br>+55 (11) 3958-4929<br><a href="https://setatelecom.com.br/" style="color:#0754a6">setatelecom.com.br</a></td></tr></table><hr style="border:0;border-top:1px solid #d9dee7;margin:32px 0 20px"><p style="font-size:12px;color:#697386"><strong>Nota de Confidencialidade 1</strong><br>As informações contidas nesta proposta comercial ou e-mail são de caráter sigiloso, com intuito de evitar a divulgação a terceiros de qualquer informação trocada entre as partes que esteja diretamente relacionada ao serviço prestado ao cliente.</p><p style="font-size:12px;color:#697386"><strong>Nota de Confidencialidade 2</strong><br>Este termo de confidencialidade é firmado com o intuito de proibir a divulgação e utilização não autorizada das informações confidenciais trocadas entre as partes por ocasião da realização do serviço contratado pelo cliente, mediante proposta assinada pelo mesmo.</p></div></body></html>`;
  return { html, text };
}

async function legacyRequest(path, { method = 'GET', body } = {}) {
  if (!CONNECTOR_API_KEY) {
    const err = new Error('CONNECTOR_API_KEY nao configurado');
    err.status = 503;
    err.source = 'legacy';
    err.data = { missing: ['CONNECTOR_API_KEY'] };
    throw err;
  }

  const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CONNECTOR_API_KEY}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (response.ok) return data;

  const err = new Error(`Legacy connector error ${response.status}`);
  err.status = response.status;
  err.source = 'legacy';
  err.data = data;
  throw err;
}

function normalizeRecipient(value, index) {
  const email = String(value?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError(`destinatarios[${index}].email invalido`, { field: `destinatarios[${index}].email` });
  return {
    email,
    firstName: String(value?.firstName || value?.firstname || value?.nome || '').trim(),
    lastName: String(value?.lastName || value?.lastname || value?.sobrenome || '').trim(),
    contactId: value?.contact_id || value?.contactId ? String(value.contact_id || value.contactId) : null
  };
}

function publicContact(contact) {
  const properties = contact?.properties || {};
  return {
    id: contact?.id ? String(contact.id) : null,
    email: String(properties.email || '').trim().toLowerCase() || null,
    firstName: String(properties.firstname || '').trim(),
    lastName: String(properties.lastname || '').trim(),
    phone: String(properties.mobilephone || properties.phone || '').trim() || null,
    company: String(properties.company || '').trim() || null
  };
}

function hubspotScopeError(err, operation) {
  if (err?.source !== 'hubspot' || err?.status !== 403 || err?.data?.category !== 'MISSING_SCOPES') return err;
  const missingScopes = err.data?.missingScopes || err.data?.missing_scopes || err.data?.context?.missingScopes || null;
  const requiredScopes = operation === 'update_contact_email'
    ? ['crm.objects.contacts.write']
    : (Array.isArray(missingScopes) ? missingScopes : null);
  const wrapped = new Error('A conexao HubSpot nao possui as permissoes necessarias para esta operacao. O e-mail foi enviado pelo Outlook, mas nao foi registrado no HubSpot.');
  wrapped.status = 503;
  wrapped.source = 'hubspot';
  wrapped.data = {
    code: 'HUBSPOT_MISSING_SCOPES',
    operation,
    required_scopes: requiredScopes,
    remediation: 'Atualize as permissoes indicadas pelo HubSpot no Private App e reconecte o HUBSPOT_ACCESS_TOKEN. Nenhum contato foi alterado.',
    hubspot: err.data
  };
  return wrapped;
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

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function companySearchTerms(value) {
  const normalized = normalizeText(value).replace(/[^a-z0-9\s.-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const ignored = new Set(['brasil', 'brazil', 'industria', 'industrial', 'comercio', 'comercial', 'servicos', 'servico', 'tecnologia', 'ltda', 'sa', 's/a', 'e', 'de', 'da', 'do', 'das', 'dos']);
  const meaningful = normalized.split(/\s+/).filter(token => token.length >= 2 && !ignored.has(token));
  const terms = [normalized];
  if (meaningful.length) terms.push(meaningful.join(' '));
  if (meaningful[0]) terms.push(meaningful[0]);
  return [...new Set(terms.map(term => term.trim()).filter(term => term.length >= 2))];
}

function mergeCompanyCandidates(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const key = String(item?.id || `${normalizeText(item?.properties?.name)}|${normalizeText(item?.properties?.domain)}`);
      if (!map.has(key)) map.set(key, item);
    }
  }
  return [...map.values()];
}

function collectionFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'dados', 'results', 'orcamentos', 'items', 'registros']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function objectFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  for (const key of ['data', 'dados', 'result', 'orcamento', 'item', 'registro']) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) return payload[key];
  }
  return payload;
}

function findProposalByNumber(payload, numero) {
  const list = collectionFromPayload(payload);
  const match = list.find(item => {
    const value = item?.codigo ?? item?.numero ?? item?.numero_proposta ?? item?.codigo_orcamento;
    return String(value ?? '') === String(numero);
  });
  if (match) return match;
  if (list.length === 1) return list[0];
  const single = objectFromPayload(payload);
  if (single && typeof single === 'object') {
    const value = single.codigo ?? single.numero ?? single.numero_proposta ?? single.codigo_orcamento;
    if (String(value ?? '') === String(numero)) return single;
  }
  return null;
}

function firstValue(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return null;
}

function proposalIdentity(proposal) {
  const customer = proposal?.cliente && typeof proposal.cliente === 'object' ? proposal.cliente : null;
  const companyName = firstValue([customer, proposal], ['razao_social', 'nome', 'cliente_nome', 'nome_cliente', 'empresa', 'cliente_razao_social']);
  const email = firstValue([customer, proposal], ['email', 'cliente_email', 'email_cliente']);
  const website = firstValue([customer, proposal], ['domain', 'dominio', 'website', 'site']);
  let domain = String(website || '').trim().toLowerCase();
  if (domain) domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain && email && String(email).includes('@')) domain = String(email).split('@').pop().trim().toLowerCase();
  const customerId = firstValue([customer, proposal], ['id', 'cliente_id', 'id_cliente']);
  return {
    company_name: companyName ? String(companyName).trim() : null,
    customer_id: customerId ? String(customerId) : null,
    email: email ? String(email).trim().toLowerCase() : null,
    domain: domain || null
  };
}

function proposalPublicLink(proposal, summary = null) {
  const sources = [proposal, summary, proposal?.orcamento, proposal?.proposta, summary?.orcamento, summary?.proposta];
  const explicitLink = firstValue(sources, ['public_link', 'link_proposta', 'url_proposta', 'link', 'url']);
  if (explicitLink && /^https?:\/\//i.test(String(explicitLink).trim())) {
    return { hash: null, public_link: String(explicitLink).trim(), source: 'erp_explicit_link' };
  }
  const hash = firstValue(sources, ['hash', 'hash_publico', 'public_hash']);
  if (!hash) return { hash: null, public_link: null, source: null };
  const normalizedHash = String(hash).trim();
  return {
    hash: normalizedHash,
    public_link: `${PROPOSAL_PUBLIC_BASE_URL}/${encodeURIComponent(normalizedHash)}`,
    source: 'erp_hash'
  };
}

async function hubspotSearchExact(objectType, propertyName, value, properties = []) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value: String(value) }] }],
      properties,
      limit: 10
    }
  });
}

async function hubspotSearchQuery(objectType, query, properties = []) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: { query: String(query), properties, limit: 10 }
  });
}

async function getAssociatedContacts(companyId) {
  const associationPage = await hubspotRequest(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}/associations/contacts?limit=100`);
  const ids = (associationPage?.results || []).map(item => String(item.id)).filter(Boolean);
  const contacts = [];
  for (const id of ids.slice(0, 100)) {
    try {
      const contact = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=firstname,lastname,email,phone,hubspot_owner_id`);
      contacts.push(contact);
    } catch (err) {
      contacts.push({ id, error: err.message });
    }
  }
  return contacts;
}

async function getAssociatedEmails(dealId) {
  const associationPage = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/emails?limit=100`);
  const ids = (associationPage?.results || []).map(item => String(item.id)).filter(Boolean);
  const emails = [];
  for (const id of ids.slice(0, 50)) {
    try {
      const email = await hubspotRequest(`/crm/v3/objects/emails/${encodeURIComponent(id)}?properties=hs_timestamp,hs_email_subject,hs_email_status,hs_email_direction,hs_email_from_email,hs_email_to_email,hs_email_text`);
      emails.push(email);
    } catch (err) {
      emails.push({ id, error: err.message });
    }
  }
  return emails.sort((a, b) => String(b?.properties?.hs_timestamp || '').localeCompare(String(a?.properties?.hs_timestamp || '')));
}

function stageLabel(stage, pipeline, rules) {
  const map = {
    default: { appointmentscheduled: 'Lead Gerado', '1341580032': 'Reunião Agendada', '20205433': 'Aguardando Proposta', qualifiedtobuy: 'Proposta Enviada', '10765435': 'Negociação', '55772800': 'FUP', '222315381': 'Final FuP', '20072970': 'Ganho', '55522584': 'Perdido' },
    '9501279': { '9501281': 'Lead Gerado', '1374787152': 'Reunião Agendada', '9501282': 'Aguardando Proposta', '9501283': 'Proposta Enviada', '14236287': 'Negociação', '55787052': 'FUP', '222285129': 'Final FuP', '14236286': 'Ganho', '222271749': 'Pós-venda cross+upsell', '55587368': 'Perdido' }
  };
  if (map[pipeline]?.[stage]) return map[pipeline][stage];
  for (const typeRule of Object.values(rules.types || {})) {
    if (String(typeRule.hubspot_pipeline) !== String(pipeline)) continue;
    if (String(typeRule.hubspot_stage_aguardando_proposta) === String(stage)) return 'Aguardando Proposta';
    if (String(typeRule.hubspot_stage_proposta_enviada) === String(stage)) return 'Proposta Enviada';
    if (String(typeRule.hubspot_stage_ganho) === String(stage)) return 'Ganho';
  }
  return stage || null;
}

function recommendedAction(deal, emails, rules, dealLookupStatus = 'success', companyLookupStatus = 'success', companyCandidates = []) {
  if (dealLookupStatus !== 'success') return { code: 'verificar_hubspot', label: 'Repetir a consulta do Deal no HubSpot antes de decidir a próxima ação' };
  if (!deal && (companyLookupStatus === 'ambiguous' || companyCandidates.length > 1)) {
    return { code: 'selecionar_empresa', label: 'Selecionar qual empresa do HubSpot deve receber o Deal', company_candidates_count: companyCandidates.length };
  }
  if (!deal) return { code: 'criar_deal', label: 'Criar Deal no HubSpot a partir da proposta do ERP' };
  const pipeline = String(deal?.properties?.pipeline || '');
  const stage = String(deal?.properties?.dealstage || '');
  const label = stageLabel(stage, pipeline, rules);
  if (label === 'Ganho') return { code: 'ganho_concluido', label: 'Negócio já marcado como Ganho' };
  if (label === 'Perdido') return { code: 'perdido_concluido', label: 'Negócio já marcado como Perdido' };
  if (label === 'Aguardando Proposta') return { code: 'enviar_proposta', label: 'Preparar e enviar a proposta; registrar o e-mail e mover para Proposta Enviada' };
  if (['Proposta Enviada', 'Negociação', 'FUP', 'Final FuP'].includes(label)) return { code: 'analisar_followup', label: 'Analisar o negócio e o histórico de e-mails para decidir o próximo follow-up', last_email_at: emails?.[0]?.properties?.hs_timestamp || null };
  return { code: 'acompanhar_negocio', label: 'Acompanhar o negócio conforme a etapa atual' };
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
    unified_proposal_workflow: true,
    hubspot_configured: Boolean(HUBSPOT_ACCESS_TOKEN),
    connector_configured: Boolean(CONNECTOR_API_KEY)
  });
});

app.get('/erp/hubspot/health', auth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await hubspotRequest('/crm/v3/objects/contacts?limit=1&properties=email');
    return res.status(200).json({
      status: 'ok',
      hubspot: {
        configured: Boolean(HUBSPOT_ACCESS_TOKEN),
        authenticated: true,
        api_base_url: HUBSPOT_BASE_URL,
        probe: 'contacts_read',
        sample_count: Array.isArray(result?.results) ? result.results.length : 0,
        latency_ms: Date.now() - startedAt
      }
    });
  } catch (err) {
    const diagnostic = diagnosticError(err);
    return res.status(200).json({
      status: 'error',
      hubspot: {
        configured: Boolean(HUBSPOT_ACCESS_TOKEN),
        authenticated: false,
        api_base_url: HUBSPOT_BASE_URL,
        probe: 'contacts_read',
        http_status: diagnostic.status,
        error_source: diagnostic.source,
        error_message: diagnostic.message,
        error_details: diagnostic.details,
        latency_ms: Date.now() - startedAt
      }
    });
  }
});

app.get('/erp/propostas/:numero/contexto', auth, async (req, res) => {
  try {
    const numero = String(req.params.numero || '').trim();
    if (!/^\d+$/.test(numero)) throw requestError('numero da proposta deve ser numerico', { field: 'numero' });

    const erpSearch = await legacyRequest(`/erp/orcamentos?codigo=${encodeURIComponent(numero)}`);
    const summary = findProposalByNumber(erpSearch, numero);
    if (!summary) {
      return res.status(404).json({ error: 'proposal_not_found', numero_proposta: numero, message: `Proposta ${numero} nao encontrada no ERP`, erp_search: erpSearch });
    }

    const internalId = summary.id ?? summary.orcamento_id ?? summary.id_orcamento ?? null;
    let erpDetail = summary;
    let erpDetailStatus = 'skipped';
    let erpDetailError = null;
    if (internalId) {
      try {
        erpDetail = objectFromPayload(await legacyRequest(`/erp/orcamentos/${encodeURIComponent(internalId)}`)) || summary;
        erpDetailStatus = 'success';
      } catch (err) {
        erpDetail = summary;
        erpDetailStatus = 'error';
        erpDetailError = diagnosticError(err);
      }
    }

    const identity = proposalIdentity(erpDetail);
    const proposalLink = proposalPublicLink(erpDetail, summary);
    let deal = null;
    let dealLookupStatus = 'success';
    let dealLookupError = null;
    try {
      const dealSearch = await hubspotSearchExact('deals', 'numero_da_proposta', numero, ['dealname', 'numero_da_proposta', 'link_da_proposta', 'pipeline', 'dealstage', 'amount', 'deal_currency_code', 'solucao', 'hubspot_owner_id', 'createdate', 'hs_lastmodifieddate']);
      deal = dealSearch?.results?.[0] || null;
    } catch (err) {
      dealLookupStatus = 'error';
      dealLookupError = diagnosticError(err);
    }

    let company = null;
    let companyCandidates = [];
    let companyLookupStatus = 'skipped';
    let companyLookupError = null;
    let companySearchQueries = [];
    if (identity.domain || identity.company_name) {
      companyLookupStatus = 'success';
      try {
        if (identity.domain) {
          const companySearch = await hubspotSearchExact('companies', 'domain', identity.domain, ['name', 'domain', 'website', 'hubspot_owner_id']);
          companyCandidates = mergeCompanyCandidates(companyCandidates, companySearch?.results || []);
          companySearchQueries.push({ type: 'domain', value: identity.domain, count: (companySearch?.results || []).length });
        }

        if (identity.company_name) {
          for (const term of companySearchTerms(identity.company_name)) {
            const companySearch = await hubspotSearchQuery('companies', term, ['name', 'domain', 'website', 'hubspot_owner_id']);
            companyCandidates = mergeCompanyCandidates(companyCandidates, companySearch?.results || []);
            companySearchQueries.push({ type: term === normalizeText(identity.company_name) ? 'full_name' : 'name_candidate', value: term, count: (companySearch?.results || []).length });
          }
        }

        if (companyCandidates.length === 1) {
          company = companyCandidates[0];
        } else if (companyCandidates.length > 1) {
          company = null;
          companyLookupStatus = 'ambiguous';
        }
      } catch (err) {
        companyLookupStatus = 'error';
        companyLookupError = diagnosticError(err);
      }
    }

    const companySelectionRequired = companyLookupStatus === 'ambiguous' || (!company && companyCandidates.length > 1);

    let contacts = [];
    let contactsLookupStatus = company?.id ? 'success' : 'skipped';
    let contactsLookupError = null;
    if (company?.id) {
      try { contacts = await getAssociatedContacts(company.id); }
      catch (err) { contactsLookupStatus = 'error'; contactsLookupError = diagnosticError(err); }
    }

    let emails = [];
    let emailLookupStatus = deal?.id ? 'success' : 'skipped';
    let emailLookupError = null;
    if (deal?.id) {
      try { emails = await getAssociatedEmails(deal.id); }
      catch (err) { emailLookupStatus = 'error'; emailLookupError = diagnosticError(err); }
    }

    const rules = loadProposalRules();
    const currentPipeline = deal?.properties?.pipeline || null;
    const currentStage = deal?.properties?.dealstage || null;
    const partial = [dealLookupStatus, companyLookupStatus, contactsLookupStatus, emailLookupStatus].includes('error');

    res.json({
      status: partial ? 'partial_success' : 'success',
      numero_proposta: numero,
      source_of_truth: { proposal: 'ERP Betel', crm: 'HubSpot', email_history: 'HubSpot EMAIL engagements registered after Outlook send' },
      erp: {
        found: true,
        internal_id: internalId ? String(internalId) : null,
        detail_lookup_status: erpDetailStatus,
        detail_lookup_error: erpDetailError,
        identity,
        proposal_hash: proposalLink.hash,
        public_link: proposalLink.public_link,
        public_link_source: proposalLink.source,
        proposal: erpDetail
      },
      hubspot: {
        deal_lookup_status: dealLookupStatus,
        deal_lookup_error: dealLookupError,
        deal_found: dealLookupStatus === 'success' ? Boolean(deal) : null,
        deal,
        deal_stage_label: deal ? stageLabel(currentStage, currentPipeline, rules) : null,
        company_lookup_status: companyLookupStatus,
        company_lookup_error: companyLookupError,
        company_found: companyLookupStatus === 'success' ? Boolean(company) : (companyLookupStatus === 'ambiguous' ? false : null),
        company_selection_required: companySelectionRequired,
        company,
        company_candidates: companyCandidates,
        company_search_queries: companySearchQueries,
        contacts_lookup_status: contactsLookupStatus,
        contacts_lookup_error: contactsLookupError,
        contacts,
        email_lookup_status: emailLookupStatus,
        email_lookup_error: emailLookupError,
        email_history: emails,
        last_email: emails[0] || null
      },
      commercial: { next_action: recommendedAction(deal, emails, rules, dealLookupStatus, companyLookupStatus, companyCandidates), workflow: rules.workflow || null }
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/erp/hubspot/contatos/pesquisar', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) throw requestError('q deve conter ao menos 2 caracteres', { field: 'q' });
    const result = await hubspotRequest('/crm/v3/objects/contacts/search', { method: 'POST', body: { query: q, limit: 20, properties: ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company'] } });
    res.json({ results: (result?.results || []).map(publicContact) });
  } catch (err) { handleError(err, res); }
});

// This endpoint makes an intentional CRM edit. A recipient may always be edited for
// a single send through /erp/email/enviar-proposta without calling this route.
app.patch('/erp/hubspot/contatos/:id/email', auth, async (req, res) => {
  try {
    const contactId = String(req.params.id || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!contactId) throw requestError('id do contato e obrigatorio', { field: 'id' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw requestError('email invalido', { field: 'email' });
    if (req.body?.confirmar_atualizacao !== true) {
      throw requestError('confirmar_atualizacao deve ser true para alterar o e-mail no HubSpot', { field: 'confirmar_atualizacao' });
    }
    const updated = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PATCH', body: { properties: { email } }
    });
    res.json({ status: 'updated', contact: publicContact(updated), updated_fields: ['email'] });
  } catch (err) { handleError(hubspotScopeError(err, 'update_contact_email'), res); }
});

app.post('/erp/email/enviar-proposta', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const rawRecipients = Array.isArray(body.destinatarios) ? body.destinatarios : [body.para || body.to].filter(Boolean);
    const recipientObjects = rawRecipients.map((value, index) => normalizeRecipient(typeof value === 'string' ? { email: value } : value, index));
    const destinatarios = [...new Set(recipientObjects.map(item => item.email))];
    if (!destinatarios.length) {
      throw requestError('Informe pelo menos um destinatario valido', { field: 'destinatarios' });
    }
    if (destinatarios.length > 10) throw requestError('destinatarios aceita no maximo 10 itens', { field: 'destinatarios' });
    const assunto = String(body.assunto || body.subject || '').trim();
    const linkProposta = String(body.link_proposta || body.proposal_link || '').trim();
    const numeroProposta = String(body.numero_proposta || '').trim();
    if (!assunto) throw requestError('assunto e obrigatorio', { field: 'assunto' });
    if (!numeroProposta) throw requestError('numero_proposta e obrigatorio', { field: 'numero_proposta' });
    if (!linkProposta || !/^https:\/\//i.test(linkProposta)) throw requestError('link_proposta HTTPS e obrigatorio', { field: 'link_proposta' });

    const template = proposalEmailTemplate({
      contactName: String(body.nome_contato || '').trim(),
      proposalTitle: String(body.titulo_proposta || 'Sua Proposta Comercial').trim(),
      proposalNumber: numeroProposta,
      proposalLink: linkProposta,
      returnDate: String(body.data_retorno || '').trim(),
      customBody: String(body.corpo || body.body || '').trim()
    });
    const sent = await sendOutlookMail({ to: destinatarios, subject: assunto, html: template.html });
    res.status(201).json({
      status: 'sent',
      provider: 'microsoft_graph',
      sender: OUTLOOK_SENDER_EMAIL,
      recipients: destinatarios,
      recipients_detail: recipientObjects.map(item => ({ ...item, contact_id: item.contactId || null })),
      subject: assunto,
      sent_at: new Date().toISOString(),
      request_id: sent.request_id,
      proposal_number: numeroProposta,
      proposal_link: linkProposta,
      rendered_html: template.html,
      rendered_text: template.text
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/erp/hubspot/emails/registrar-envio', auth, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.envio_confirmado !== true) throw requestError('envio_confirmado deve ser true. Esta rota registra apenas e-mails realmente enviados pelo Outlook.', { field: 'envio_confirmado' });
    const remetenteEmail = String(body.remetente?.email || body.remetente_email || '').trim().toLowerCase();
    if (!remetenteEmail || !remetenteEmail.includes('@')) throw requestError('remetente.email e obrigatorio', { field: 'remetente.email' });
    if (!Array.isArray(body.destinatarios) || body.destinatarios.length === 0) throw requestError('destinatarios deve conter pelo menos um destinatario', { field: 'destinatarios' });
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
      from: { email: remetenteEmail, firstName: String(body.remetente?.firstName || body.remetente?.firstname || body.remetente?.nome || '').trim(), lastName: String(body.remetente?.lastName || body.remetente?.lastname || body.remetente?.sobrenome || '').trim() },
      sender: { email: remetenteEmail, firstName: String(body.remetente?.firstName || body.remetente?.firstname || body.remetente?.nome || '').trim(), lastName: String(body.remetente?.lastName || body.remetente?.lastname || body.remetente?.sobrenome || '').trim() },
      to: destinatarios, cc, bcc
    };

    const properties = { hs_timestamp: timestamp.toISOString(), hs_email_direction: 'EMAIL', hs_email_status: 'SENT', hs_email_subject: assunto, hs_email_text: texto, hs_email_headers: JSON.stringify(headers) };
    if (body.html) properties.hs_email_html = String(body.html);
    if (body.hubspot_owner_id) properties.hubspot_owner_id = String(body.hubspot_owner_id);
    const initialAssociations = [];
    if (body.deal_id) initialAssociations.push({ to: { id: String(body.deal_id) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 210 }] });
    const email = await hubspotRequest('/crm/v3/objects/emails', {
      method: 'POST',
      body: { properties, ...(initialAssociations.length ? { associations: initialAssociations } : {}) }
    });

    const associationResults = [];
    const associationFailures = [];
    if (body.deal_id) associationResults.push({ type: 'deals', id: String(body.deal_id), mode: 'atomic_create' });
    const targets = [body.company_id ? { type: 'companies', id: body.company_id } : null, ...(Array.isArray(body.contact_ids) ? body.contact_ids.map(id => ({ type: 'contacts', id })) : [])].filter(Boolean);
    for (const target of targets) {
      try { await associateEmail(email.id, target.type, target.id); associationResults.push(target); }
      catch (err) { associationFailures.push({ target, status: err.status || 500, details: err.data || err.message }); }
    }

    let dealAssociationVerified = !body.deal_id;
    if (body.deal_id) {
      const verification = await hubspotRequest(`/crm/v3/objects/emails/${encodeURIComponent(email.id)}?associations=deals`);
      const associatedDealIds = verification?.associations?.deals?.results?.map(item => String(item.id)) || [];
      dealAssociationVerified = associatedDealIds.includes(String(body.deal_id));
      if (!dealAssociationVerified) {
        await hubspotRequest(`/crm/v3/objects/emails/${encodeURIComponent(email.id)}/associations/deal/${encodeURIComponent(body.deal_id)}/210`, { method: 'PUT' });
        const retry = await hubspotRequest(`/crm/v3/objects/emails/${encodeURIComponent(email.id)}?associations=deals`);
        dealAssociationVerified = (retry?.associations?.deals?.results || []).some(item => String(item.id) === String(body.deal_id));
      }
      if (!dealAssociationVerified) throw new Error('HubSpot criou o e-mail, mas não confirmou a associação ao deal.');
    }

    let dealStageUpdate = null;
    if (body.atualizar_etapa === true) {
      if (!body.deal_id) throw requestError('deal_id e obrigatorio quando atualizar_etapa=true', { field: 'deal_id' });
      const tipo = String(body.tipo_proposta || '').trim().toLowerCase();
      const rules = loadProposalRules();
      const typeRule = rules.types?.[tipo];
      if (!typeRule) throw requestError('tipo_proposta invalido para atualizar a etapa', { field: 'tipo_proposta', allowed: Object.keys(rules.types || {}) });
      dealStageUpdate = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(body.deal_id)}`, { method: 'PATCH', body: { properties: { dealstage: typeRule.hubspot_stage_proposta_enviada } } });
    }

    res.status(201).json({ status: associationFailures.length ? 'partial_success' : 'success', email: { id: email.id, subject: assunto, status: 'SENT', direction: 'EMAIL', timestamp: timestamp.toISOString(), outlook_message_id: body.outlook_message_id || null }, associations: associationResults, association_failures: associationFailures, deal_association_verified: dealAssociationVerified, deal_stage_updated: Boolean(dealStageUpdate), deal: dealStageUpdate });
  } catch (err) {
    handleError(hubspotScopeError(err, 'register_sent_email'), res);
  }
});

app.post('/erp/hubspot/negocios/:id/marcar-ganho', auth, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.confirmacao_ganho !== true) throw requestError('confirmacao_ganho deve ser true. O negocio so pode ser marcado como ganho apos confirmacao explicita do usuario.', { field: 'confirmacao_ganho' });
    const tipo = String(body.tipo_proposta || '').trim().toLowerCase();
    const rules = loadProposalRules();
    const typeRule = rules.types?.[tipo];
    if (!typeRule) throw requestError('tipo_proposta invalido', { field: 'tipo_proposta', allowed: Object.keys(rules.types || {}) });
    if (!typeRule.hubspot_stage_ganho) throw requestError('Etapa Ganho nao configurada para este tipo de proposta', { field: 'tipo_proposta' });
    const wonRules = rules.deal_won || {};
    const allowedReasons = wonRules.allowed_reasons || [];
    const rawReasons = Array.isArray(body.motivos_ganho) ? body.motivos_ganho : (body.motivo_ganho ? [body.motivo_ganho] : []);
    const reasons = [...new Set(rawReasons.map(value => String(value || '').trim()).filter(Boolean))];
    if (reasons.length === 0) throw requestError('motivos_ganho deve conter pelo menos um motivo', { field: 'motivos_ganho', allowed: allowedReasons });
    const invalidReasons = reasons.filter(reason => !allowedReasons.includes(reason));
    if (invalidReasons.length) throw requestError('Um ou mais motivos_ganho sao invalidos', { field: 'motivos_ganho', invalid: invalidReasons, allowed: allowedReasons });
    if (wonRules.allow_multiple_reasons === false && reasons.length > 1) throw requestError('A configuracao atual permite somente um motivo de ganho', { field: 'motivos_ganho' });

    const dealId = String(req.params.id || '').trim();
    const currentDeal = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname,pipeline,dealstage,numero_da_proposta`);
    const currentPipeline = String(currentDeal?.properties?.pipeline || '');
    if (currentPipeline !== String(typeRule.hubspot_pipeline)) throw requestError('O pipeline atual do negocio nao corresponde ao tipo_proposta informado. Nenhuma alteracao foi feita.', { deal_id: dealId, current_pipeline: currentPipeline, expected_pipeline: typeRule.hubspot_pipeline, tipo_proposta: tipo });

    const reasonProperty = wonRules.reason_property || 'descricao_motivo_ganho__clonado_';
    const separator = String(wonRules.separator || ';');
    const serializedReasons = reasons.join(separator);
    const updatedDeal = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { method: 'PATCH', body: { properties: { dealstage: String(typeRule.hubspot_stage_ganho), [reasonProperty]: serializedReasons } } });

    res.json({ status: 'success', deal: updatedDeal, deal_id: dealId, deal_name: currentDeal?.properties?.dealname || null, numero_proposta: currentDeal?.properties?.numero_da_proposta || null, tipo_proposta: tipo, pipeline: typeRule.hubspot_pipeline, etapa_anterior: currentDeal?.properties?.dealstage || null, etapa_ganho: typeRule.hubspot_stage_ganho, motivos_ganho: reasons, motivo_property: reasonProperty });
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
    const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${req.originalUrl}`, { method: req.method, headers, body });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    const correlationId = response.headers.get('x-correlation-id');
    if (correlationId) res.setHeader('x-correlation-id', correlationId);
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'legacy_connector_unavailable', message: err.message });
  }
}

app.use(proxyToLegacy);

const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(INTERNAL_PORT) }, stdio: 'inherit' });
child.on('exit', (code, signal) => { console.error(`Legacy connector exited code=${code} signal=${signal}`); });

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
