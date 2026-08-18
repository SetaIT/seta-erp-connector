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
      details: err.data
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

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
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

function recommendedAction(deal, emails, rules, dealLookupStatus = 'success') {
  if (dealLookupStatus !== 'success') return { code: 'verificar_hubspot', label: 'Repetir a consulta do Deal no HubSpot antes de decidir a próxima ação' };
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
    if (identity.domain || identity.company_name) {
      companyLookupStatus = 'success';
      try {
        if (identity.domain) {
          const companySearch = await hubspotSearchExact('companies', 'domain', identity.domain, ['name', 'domain', 'website', 'hubspot_owner_id']);
          companyCandidates = companySearch?.results || [];
          company = companyCandidates[0] || null;
        }
        if (!company && identity.company_name) {
          const companySearch = await hubspotSearchQuery('companies', identity.company_name, ['name', 'domain', 'website', 'hubspot_owner_id']);
          companyCandidates = companySearch?.results || [];
          company = companyCandidates.find(item => normalizeText(item?.properties?.name) === normalizeText(identity.company_name)) || companyCandidates[0] || null;
        }
      } catch (err) {
        companyLookupStatus = 'error';
        companyLookupError = diagnosticError(err);
      }
    }

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
        company_found: companyLookupStatus === 'success' ? Boolean(company) : null,
        company,
        company_candidates: companyCandidates,
        contacts_lookup_status: contactsLookupStatus,
        contacts_lookup_error: contactsLookupError,
        contacts,
        email_lookup_status: emailLookupStatus,
        email_lookup_error: emailLookupError,
        email_history: emails,
        last_email: emails[0] || null
      },
      commercial: { next_action: recommendedAction(deal, emails, rules, dealLookupStatus), workflow: rules.workflow || null }
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
    if (body.hubspot_owner_id) properties.hubspot_owner_id = String(body.hubspot_owner_id);
    const email = await hubspotRequest('/crm/v3/objects/emails', { method: 'POST', body: { properties } });

    const associationResults = [];
    const associationFailures = [];
    const targets = [body.deal_id ? { type: 'deals', id: body.deal_id } : null, body.company_id ? { type: 'companies', id: body.company_id } : null, ...(Array.isArray(body.contact_ids) ? body.contact_ids.map(id => ({ type: 'contacts', id })) : [])].filter(Boolean);
    for (const target of targets) {
      try { await associateEmail(email.id, target.type, target.id); associationResults.push(target); }
      catch (err) { associationFailures.push({ target, status: err.status || 500, details: err.data || err.message }); }
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

    res.status(201).json({ status: associationFailures.length ? 'partial_success' : 'success', email: { id: email.id, subject: assunto, status: 'SENT', direction: 'EMAIL', timestamp: timestamp.toISOString(), outlook_message_id: body.outlook_message_id || null }, associations: associationResults, association_failures: associationFailures, deal_stage_updated: Boolean(dealStageUpdate), deal: dealStageUpdate });
  } catch (err) {
    handleError(err, res);
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
