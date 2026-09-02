import express from 'express';

// The public gateway has to own this route.  Routes registered only in server.js
// are otherwise hidden behind the legacy proxy and cannot be reliably used by the
// dashboard/action.
const originalUse = express.application.use;
const originalPost = express.application.post;
let routesInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

const CLONE_FIELDS = [
  'tipo', 'cliente_id', 'situacao_id', 'vendedor_id', 'validade', 'previsao_entrega', 'prazo_entrega',
  'condicao_pagamento', 'forma_pagamento_id', 'data_primeira_parcela', 'numero_parcelas', 'intervalo_dias',
  'pagamentos', 'produtos', 'servicos', 'desconto_valor', 'desconto_porcentagem', 'tipo_desconto',
  'introducao', 'observacoes', 'observacoes_interna'
];

function authorized(req) {
  return Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);
}

function configured() {
  return Boolean(BETEL_ACCESS_TOKEN && BETEL_SECRET_ACCESS_TOKEN);
}

function validNumber(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function proposalData(payload) {
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
  const single = proposalData(payload);
  if (single && typeof single === 'object') {
    const value = single.codigo ?? single.numero ?? single.numero_proposta ?? single.codigo_orcamento;
    if (String(value ?? '') === target) return single;
  }
  return null;
}

function compact(value, maxLength = 2000) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...`;
  try { return JSON.parse(text); } catch { return text; }
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

async function resolveByNumber(numero) {
  let listed;
  try { listed = await betel(`/orcamentos?codigo=${encodeURIComponent(numero)}`); }
  catch (err) { return { ok: false, stage: 'resolve_number_transport', message: err.message }; }
  if (!listed.ok) return { ok: false, stage: 'resolve_number', betel_http_status: listed.status, betel_details: compact(listed.data) };

  const summary = findProposalByNumber(listed.data, numero);
  const id = String(summary?.id ?? summary?.orcamento_id ?? summary?.id_orcamento ?? '').trim();
  if (!summary) return { ok: false, notFound: true, stage: 'resolve_number', message: 'Proposta nao encontrada pelo numero comercial.' };
  // A matching code without an internal ID is not proof that the code is free.
  // Treat it as an inconclusive lookup so clone precheck remains fail-closed.
  if (!id) return { ok: false, stage: 'resolve_number_missing_id', message: 'ERP retornou uma proposta com este numero, mas sem ID interno para verificacao segura.' };

  let loaded;
  try { loaded = await betel(`/orcamentos/${encodeURIComponent(id)}`); }
  catch (err) { return { ok: false, stage: 'load_resolved_proposal_transport', id, message: err.message }; }
  if (!loaded.ok) return { ok: false, stage: 'load_resolved_proposal', id, betel_http_status: loaded.status, betel_details: compact(loaded.data) };
  const proposal = proposalData(loaded.data);
  if (String(proposal?.codigo ?? '') !== String(numero)) return { ok: false, stage: 'identity_mismatch', id, codigo_retornado: proposal?.codigo ?? null, message: 'O ID resolvido nao corresponde ao numero comercial solicitado.' };
  return { ok: true, id, proposal };
}

function clonePayload(original, novoCodigo, body) {
  const payload = Object.fromEntries(CLONE_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(original, field))
    .map(field => [field, original[field]]));
  payload.tipo = payload.tipo || (Array.isArray(payload.servicos) && !payload.produtos?.length ? 'servico' : 'produto');
  payload.codigo = Number(novoCodigo);
  payload.cliente_id = original?.cliente_id;
  payload.situacao_id = original?.situacao_id;
  payload.data = body.data || new Date().toISOString().slice(0, 10);
  if (!payload.cliente_id || !payload.situacao_id) throw new Error('A proposta original nao possui cliente_id ou situacao_id para clonagem segura.');
  if (Object.prototype.hasOwnProperty.call(body, 'introducao')) payload.introducao = body.introducao;
  if (Object.prototype.hasOwnProperty.call(body, 'observacoes')) payload.observacoes = body.observacoes;
  // Frete formal nunca e copiado: qualquer informacao comercial deve ficar em observacoes.
  delete payload.valor_frete;
  return payload;
}

async function cloneByNumberHandler(req, res) {
  const numero = String(req.params.numero || '').trim();
  const body = req.body || {};
  const novoCodigo = String(body.novo_codigo ?? body.codigo ?? '').trim();
  if (!authorized(req)) return res.status(200).json({ status: 'error', stage: 'authentication', write_attempted: false, write_succeeded: false, message: 'unauthorized' });
  if (!configured()) return res.status(200).json({ status: 'error', stage: 'configuration', write_attempted: false, write_succeeded: false, message: 'Credenciais Betel nao configuradas no Railway.' });
  if (!validNumber(numero) || !validNumber(novoCodigo)) return res.status(200).json({ status: 'error', stage: 'validation', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo || null, message: 'numero da origem e novo_codigo devem ser numericos.' });
  if (numero === novoCodigo) return res.status(200).json({ status: 'error', stage: 'validation', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, message: 'novo_codigo deve ser diferente do numero da proposta original.' });
  if (body.confirmacao_clonagem !== true) return res.status(200).json({ status: 'error', stage: 'confirmation', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, message: 'confirmacao_clonagem deve ser true apos revisar a nova proposta.' });

  const source = await resolveByNumber(numero);
  if (!source.ok) return res.status(200).json({ status: source.notFound ? 'not_found' : 'error', stage: source.stage, write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, message: source.message ?? null, betel_http_status: source.betel_http_status ?? null, betel_details: source.betel_details ?? null });

  // A clone is a write: uncertainty in the duplicate check is a hard stop.
  const precheck = await resolveByNumber(novoCodigo);
  if (precheck.ok) return res.status(200).json({ status: 'duplicate', stage: 'precheck_duplicate', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, existing_proposal_id: precheck.id, message: 'Ja existe uma proposta com este novo_codigo. Nenhuma clonagem foi executada.' });
  if (!precheck.notFound) return res.status(200).json({ status: 'blocked', stage: 'precheck_inconclusive', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, message: 'Nao foi possivel confirmar que o novo codigo esta livre. Nenhuma clonagem foi executada.', precheck_stage: precheck.stage, betel_http_status: precheck.betel_http_status ?? null, betel_details: precheck.betel_details ?? null });

  let payload;
  try { payload = clonePayload(source.proposal, novoCodigo, body); }
  catch (err) { return res.status(200).json({ status: 'error', stage: 'prepare_clone_payload', write_attempted: false, write_succeeded: false, numero, novo_codigo: novoCodigo, message: err.message }); }

  let created;
  try { created = await betel('/orcamentos', { method: 'POST', body: payload }); }
  catch (err) { return res.status(200).json({ status: 'error', stage: 'betel_clone_transport', write_attempted: true, write_succeeded: false, numero, novo_codigo: novoCodigo, message: err.message }); }
  if (!created.ok) return res.status(200).json({ status: 'error', stage: 'betel_clone', write_attempted: true, write_succeeded: false, numero, novo_codigo: novoCodigo, betel_http_status: created.status, betel_details: compact(created.data) });

  const verification = await resolveByNumber(novoCodigo);
  if (!verification.ok) return res.status(200).json({ status: 'success_unverified', stage: verification.stage || 'verification', write_attempted: true, write_succeeded: true, verification_succeeded: false, numero, novo_codigo: novoCodigo, message: 'ERP confirmou a criacao, mas a nova proposta nao pode ser confirmada por numero. Nao repetir a clonagem automaticamente.' });
  return res.status(200).json({ status: 'success', stage: 'completed', write_attempted: true, write_succeeded: true, verification_succeeded: true, action: 'proposal_cloned', proposta_origem: { numero, id: source.id }, nova_proposta: { numero: novoCodigo, id: verification.id }, cloned_fields: Object.keys(payload).filter(field => field !== 'codigo' && field !== 'data'), connector_write_mode: 'gateway_direct_betel_number_resolution' });
}

express.application.use = function patchedCloneByNumberUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!routesInstalled && proxyFn?.name === 'proxyToLegacy') {
    routesInstalled = true;
    originalPost.call(this, '/erp/orcamentos/numero/:numero/clonar', cloneByNumberHandler);
    console.log('Installed proposal clone route by commercial number before legacy proxy');
  }
  return originalUse.apply(this, args);
};
