import express from 'express';

const originalUse = express.application.use;
const originalPut = express.application.put;
const originalDelete = express.application.delete;
let routesInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const ERP_SUPERVISOR_BASE_URL = String(process.env.ERP_SUPERVISOR_BASE_URL || '').replace(/\/$/, '');
const ERP_SUPERVISOR_TOKEN = String(process.env.ERP_SUPERVISOR_TOKEN || '').trim();
const GESTAOCLICK_MCP_WRITES_ENABLED = String(process.env.GESTAOCLICK_MCP_WRITES_ENABLED || 'false').toLowerCase() === 'true';
const GESTAOCLICK_MCP_READS_ENABLED = String(process.env.GESTAOCLICK_MCP_READS_ENABLED || 'false').toLowerCase() === 'true';

const EDITABLE_FIELDS = [
  'data',
  'validade',
  'situacao_id',
  'vendedor_id',
  'previsao_entrega',
  'prazo_entrega',
  'valor_frete',
  'condicao_pagamento',
  'forma_pagamento_id',
  'data_primeira_parcela',
  'numero_parcelas',
  'intervalo_dias',
  'pagamentos',
  'introducao',
  'observacoes',
  'observacoes_interna'
];

const PRESERVED_UPDATE_FIELDS = [
  'nome_cliente', 'vendedor_id', 'nome_vendedor', 'tecnico_id', 'nome_tecnico',
  'previsao_entrega', 'nome_situacao', 'valor_total', 'nome_transportadora',
  'transportadora_id', 'centro_custo_id', 'aos_cuidados_de', 'validade',
  'introducao', 'observacoes', 'observacoes_interna', 'nome_canal_venda',
  'nome_loja', 'valor_frete', 'desconto_valor', 'desconto_porcentagem',
  'tipo_desconto', 'condicao_pagamento', 'forma_pagamento_id',
  'data_primeira_parcela', 'numero_parcelas', 'intervalo_dias', 'pagamentos',
  'produtos', 'servicos'
];

const STABILITY_FIELDS = [
  'cliente_id', 'situacao_id', 'vendedor_id', 'valor_total', 'valor_frete',
  'condicao_pagamento', 'forma_pagamento_id', 'numero_parcelas',
  'data_primeira_parcela', 'intervalo_dias', 'pagamentos', 'produtos', 'servicos'
];

function compactDetails(value, maxLength = 3000) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...`;
  try { return JSON.parse(text); } catch { return text; }
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

async function mcpRead({ recurso, acao = 'listar', id, dados = {} }) {
  if (!ERP_SUPERVISOR_BASE_URL || !ERP_SUPERVISOR_TOKEN) throw new Error('ERP Supervisor MCP read proxy is not configured');
  const response = await fetch(`${ERP_SUPERVISOR_BASE_URL}/mcp/gestaoclick/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ERP_SUPERVISOR_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      recurso,
      acao,
      ...(id !== undefined ? { id } : {}),
      dados
    })
  });
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok || envelope?.status !== 'ok') {
    const error = new Error(`MCP read proxy failed with HTTP ${response.status}`);
    error.details = envelope;
    throw error;
  }
  const content = Array.isArray(envelope?.result?.content) ? envelope.result.content : [];
  const text = content.find(item => item?.type === 'text')?.text;
  if (!text) throw new Error('MCP read proxy returned no text content');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('MCP read proxy returned invalid JSON'); }
  const upstreamStatus = Number(parsed?.http_status || 200);
  return {
    ok: upstreamStatus >= 200 && upstreamStatus < 300,
    status: upstreamStatus,
    data: parsed?.resposta ?? parsed,
    source: 'gestaoclick_mcp'
  };
}

async function proposalListByNumber(numero) {
  if (GESTAOCLICK_MCP_READS_ENABLED) {
    try {
      return await mcpRead({
        recurso: 'orcamentos',
        acao: 'listar',
        dados: { codigo: numero, limite: 1 }
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'gestaoclick_mcp_number_write_read_fallback',
        stage: 'list',
        numero,
        message: error?.message || String(error)
      }));
    }
  }
  const response = await betel(`/orcamentos?codigo=${encodeURIComponent(numero)}`);
  return { ...response, source: 'betel' };
}

async function proposalDetail(id) {
  if (GESTAOCLICK_MCP_READS_ENABLED) {
    try {
      return await mcpRead({
        recurso: 'orcamentos',
        acao: 'visualizar',
        id,
        dados: {}
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'gestaoclick_mcp_number_write_read_fallback',
        stage: 'detail',
        id: String(id),
        message: error?.message || String(error)
      }));
    }
  }
  const response = await betel(`/orcamentos/${encodeURIComponent(id)}`);
  return { ...response, source: 'betel' };
}

async function mcpWrite({ recurso, acao, id, dados, correlationId }) {
  if (!ERP_SUPERVISOR_BASE_URL || !ERP_SUPERVISOR_TOKEN) {
    return { ok: false, status: 503, data: { message: 'ERP Supervisor MCP write proxy is not configured' }, source: 'gestaoclick_mcp' };
  }
  const response = await fetch(`${ERP_SUPERVISOR_BASE_URL}/mcp/gestaoclick/write`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ERP_SUPERVISOR_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {})
    },
    body: JSON.stringify({
      recurso,
      acao,
      ...(id !== undefined ? { id } : {}),
      dados,
      confirmar_escrita: true
    })
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data?.status === 'ok', status: response.status, data, source: 'gestaoclick_mcp' };
}

async function updateProposal({ id, payload, correlationId }) {
  if (GESTAOCLICK_MCP_WRITES_ENABLED) {
    return mcpWrite({
      recurso: 'orcamentos',
      acao: 'editar',
      id,
      dados: payload,
      correlationId
    });
  }
  const response = await betel(`/orcamentos/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
  return { ...response, source: 'betel' };
}

function authorized(req) {
  return Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);
}

function configured() {
  return Boolean(BETEL_ACCESS_TOKEN && BETEL_SECRET_ACCESS_TOKEN);
}

function validateNumber(numero) {
  return /^\d+$/.test(String(numero || '').trim());
}

async function resolveByNumber(numero) {
  let listResponse;
  try {
    listResponse = await proposalListByNumber(numero);
  } catch (err) {
    return { ok: false, stage: 'resolve_number_transport', message: err.message };
  }
  if (!listResponse.ok) {
    return { ok: false, stage: 'resolve_number', betel_http_status: listResponse.status, betel_details: compactDetails(listResponse.data) };
  }

  const summary = findProposalByNumber(listResponse.data, numero);
  const id = String(summary?.id ?? summary?.orcamento_id ?? summary?.id_orcamento ?? '').trim();
  if (!summary || !id) {
    return { ok: false, notFound: true, stage: 'resolve_number', message: 'Proposta nao encontrada pelo numero comercial ou resposta sem ID interno.' };
  }

  let detailResponse;
  try {
    detailResponse = await proposalDetail(id);
  } catch (err) {
    return { ok: false, stage: 'load_resolved_proposal_transport', id, message: err.message };
  }
  if (!detailResponse.ok) {
    return { ok: false, stage: 'load_resolved_proposal', id, betel_http_status: detailResponse.status, betel_details: compactDetails(detailResponse.data) };
  }

  const proposal = proposalData(detailResponse.data);
  if (String(proposal?.codigo ?? '') !== String(numero)) {
    return { ok: false, stage: 'identity_mismatch', id, codigo_retornado: proposal?.codigo ?? null, message: 'O ID resolvido nao corresponde ao numero comercial solicitado.' };
  }

  return { ok: true, id, proposal, listSource: listResponse.source || 'betel', detailSource: detailResponse.source || 'betel' };
}

function parseDateToIso(value, fieldName) {
  if (value === null) return null;
  const raw = String(value || '').trim();
  let year;
  let month;
  let day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) [year, month, day] = raw.split('-').map(Number);
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) [day, month, year] = raw.split('/').map(Number);
  else {
    const err = new Error(`${fieldName} deve estar em YYYY-MM-DD ou DD/MM/YYYY`);
    err.stage = 'prepare_payload';
    err.field = fieldName;
    throw err;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    const err = new Error(`${fieldName} invalida`);
    err.stage = 'prepare_payload';
    err.field = fieldName;
    throw err;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function currentRequired(current, field) {
  const value = current?.[field];
  if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  const err = new Error(`Campo obrigatorio ${field} ausente na proposta atual`);
  err.stage = 'prepare_payload';
  err.field = field;
  throw err;
}

function inferProposalType(current) {
  if (current?.tipo) return current.tipo;
  const hasProducts = Array.isArray(current?.produtos) && current.produtos.length > 0;
  const hasServices = Array.isArray(current?.servicos) && current.servicos.length > 0;
  if (!hasProducts && hasServices) return 'servico';
  return 'produto';
}

function buildEditPayload(current, body) {
  if (body?.confirmacao_edicao !== true) {
    const err = new Error('confirmacao_edicao deve ser true apos preview e confirmacao explicita');
    err.stage = 'confirmation';
    throw err;
  }

  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, field)) changes[field] = body[field];
  }
  if (!Object.keys(changes).length) {
    const err = new Error('Informe pelo menos um campo para alterar');
    err.stage = 'prepare_payload';
    throw err;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'data')) changes.data = parseDateToIso(changes.data, 'data');
  if (Object.prototype.hasOwnProperty.call(changes, 'previsao_entrega') && changes.previsao_entrega !== null) {
    changes.previsao_entrega = parseDateToIso(changes.previsao_entrega, 'previsao_entrega');
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'data_primeira_parcela') && changes.data_primeira_parcela !== null) {
    changes.data_primeira_parcela = parseDateToIso(changes.data_primeira_parcela, 'data_primeira_parcela');
  }

  const preserved = {};
  for (const field of PRESERVED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current || {}, field)) preserved[field] = current[field];
  }

  const codigo = Number(currentRequired(current, 'codigo'));
  if (!Number.isInteger(codigo)) {
    const err = new Error('codigo atual da proposta nao e um inteiro valido');
    err.stage = 'prepare_payload';
    err.field = 'codigo';
    throw err;
  }

  const payload = {
    tipo: inferProposalType(current),
    codigo,
    cliente_id: currentRequired(current, 'cliente_id'),
    situacao_id: currentRequired(current, 'situacao_id'),
    data: parseDateToIso(currentRequired(current, 'data'), 'data'),
    ...preserved,
    ...changes
  };
  payload.codigo = codigo;
  payload.cliente_id = currentRequired(current, 'cliente_id');
  payload.situacao_id = Object.prototype.hasOwnProperty.call(changes, 'situacao_id') ? changes.situacao_id : currentRequired(current, 'situacao_id');
  payload.data = Object.prototype.hasOwnProperty.call(changes, 'data') ? changes.data : parseDateToIso(currentRequired(current, 'data'), 'data');
  payload.tipo = inferProposalType(current);
  return { payload, changes, preservedFields: Object.keys(preserved) };
}

function normalizeForComparison(value, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeForComparison(item, key));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = normalizeForComparison(childValue, childKey);
    return output;
  }
  if (key === 'desconto_valor' || key === 'desconto_porcentagem') {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (raw === '') return '0';
    const numeric = Number(raw.replace(',', '.'));
    if (Number.isFinite(numeric) && numeric === 0) return '0';
  }
  return value;
}

function stableJson(value) {
  if (value === undefined) return '__undefined__';
  try { return JSON.stringify(normalizeForComparison(value)); } catch { return String(value); }
}

function valuesForFields(source, fields) {
  const output = {};
  for (const field of fields) output[field] = source?.[field] ?? null;
  return output;
}

function stabilityCheck(before, after, changedFields) {
  const changed = new Set(changedFields);
  const checked = [];
  const unexpected = [];
  for (const field of STABILITY_FIELDS) {
    if (changed.has(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(before || {}, field) && !Object.prototype.hasOwnProperty.call(after || {}, field)) continue;
    checked.push(field);
    if (stableJson(before?.[field]) !== stableJson(after?.[field])) unexpected.push({ field, before: compactDetails(before?.[field], 1000), after: compactDetails(after?.[field], 1000) });
  }
  return { checked, unexpected };
}

async function editByNumberHandler(req, res) {
  const numero = String(req.params.numero || '').trim();
  if (!authorized(req)) return res.status(200).json({ status: 'error', stage: 'authentication', write_attempted: false, write_succeeded: false, message: 'unauthorized' });
  if (!configured()) return res.status(200).json({ status: 'error', stage: 'configuration', write_attempted: false, write_succeeded: false, message: 'Credenciais Betel nao configuradas no Railway.' });
  if (!validateNumber(numero)) return res.status(200).json({ status: 'error', stage: 'validation', write_attempted: false, write_succeeded: false, numero, message: 'numero da proposta deve ser numerico' });

  const resolved = await resolveByNumber(numero);
  if (!resolved.ok) return res.status(200).json({ status: resolved.notFound ? 'not_found' : 'error', stage: resolved.stage, write_attempted: false, write_succeeded: false, numero, resolved_id: resolved.id ?? null, betel_http_status: resolved.betel_http_status ?? null, betel_details: resolved.betel_details ?? null, codigo_retornado: resolved.codigo_retornado ?? null, message: resolved.message ?? null });

  let built;
  try { built = buildEditPayload(resolved.proposal, req.body || {}); }
  catch (err) { return res.status(200).json({ status: 'error', stage: err.stage || 'prepare_payload', write_attempted: false, write_succeeded: false, numero, field: err.field || null, message: err.message }); }

  let updateResponse;
  const correlationId = String(req.headers['x-correlation-id'] || '').trim() || undefined;
  try { updateResponse = await updateProposal({ id: resolved.id, payload: built.payload, correlationId }); }
  catch (err) {
    return res.status(200).json({
      status: GESTAOCLICK_MCP_WRITES_ENABLED ? 'write_outcome_unknown' : 'error',
      stage: GESTAOCLICK_MCP_WRITES_ENABLED ? 'mcp_update_transport' : 'betel_update_transport',
      write_attempted: true,
      write_succeeded: false,
      numero,
      write_source: GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel',
      message: err.message,
      retry_safe: false
    });
  }
  if (!updateResponse.ok) {
    return res.status(200).json({
      status: 'error',
      stage: GESTAOCLICK_MCP_WRITES_ENABLED ? 'mcp_update' : 'betel_update',
      write_attempted: true,
      write_succeeded: false,
      numero,
      write_source: updateResponse.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
      upstream_http_status: updateResponse.status,
      requested_changes: built.changes,
      upstream_details: compactDetails(updateResponse.data),
      retry_safe: false
    });
  }

  let verification;
  try { verification = await resolveByNumber(numero); }
  catch (err) { return res.status(200).json({ status: 'success_unverified', stage: 'verification_transport', write_attempted: true, write_succeeded: true, verification_succeeded: false, numero, requested_changes: built.changes, message: err.message }); }
  if (!verification.ok) return res.status(200).json({ status: 'success_unverified', stage: 'verification', write_attempted: true, write_succeeded: true, verification_succeeded: false, numero, requested_changes: built.changes, message: verification.message ?? 'Nao foi possivel confirmar a proposta apos a edicao.' });

  const stability = stabilityCheck(resolved.proposal, verification.proposal, Object.keys(built.changes));
  const afterRequested = valuesForFields(verification.proposal, Object.keys(built.changes));
  const requestedMatched = Object.entries(built.changes).every(([field, value]) => stableJson(afterRequested[field]) === stableJson(value));

  return res.status(200).json({
    status: requestedMatched && stability.unexpected.length === 0 ? 'success' : 'success_with_verification_warning',
    stage: 'completed', write_attempted: true, write_succeeded: true, verification_succeeded: true,
    requested_changes_matched: requestedMatched, unrelated_state_preserved: stability.unexpected.length === 0,
    numero, codigo: verification.proposal?.codigo ?? numero, changed_fields: Object.keys(built.changes),
    stability_fields_checked: stability.checked, unexpected_changes: stability.unexpected,
    before: valuesForFields(resolved.proposal, Object.keys(built.changes)), requested: built.changes, after: afterRequested,
    connector_write_mode: GESTAOCLICK_MCP_WRITES_ENABLED ? 'mcp_edit_with_post_write_verification' : 'direct_betel_number_resolution',
    write_source: updateResponse.source || (GESTAOCLICK_MCP_WRITES_ENABLED ? 'gestaoclick_mcp' : 'betel'),
    read_sources: {
      before_list: resolved.listSource || 'betel',
      before_detail: resolved.detailSource || 'betel',
      after_list: verification.listSource || 'betel',
      after_detail: verification.detailSource || 'betel'
    }
  });
}

async function deleteByNumberHandler(req, res) {
  const numero = String(req.params.numero || '').trim();
  if (!authorized(req)) return res.status(200).json({ status: 'error', stage: 'authentication', delete_attempted: false, delete_succeeded: false, message: 'unauthorized' });
  if (!configured()) return res.status(200).json({ status: 'error', stage: 'configuration', delete_attempted: false, delete_succeeded: false, message: 'Credenciais Betel nao configuradas no Railway.' });
  if (!validateNumber(numero)) return res.status(200).json({ status: 'error', stage: 'validation', delete_attempted: false, delete_succeeded: false, numero, message: 'numero da proposta deve ser numerico' });

  const body = req.body || {};
  if (body.confirmacao_exclusao !== true) return res.status(200).json({ status: 'error', stage: 'confirmation', delete_attempted: false, delete_succeeded: false, numero, message: 'confirmacao_exclusao deve ser true apos preview e confirmacao explicita.' });
  const codigoConfirmacao = String(body.codigo_confirmacao ?? '').trim();
  if (codigoConfirmacao !== numero) return res.status(200).json({ status: 'error', stage: 'confirmation_mismatch', delete_attempted: false, delete_succeeded: false, numero, codigo_confirmacao: codigoConfirmacao, message: 'codigo_confirmacao deve ser igual ao numero comercial informado na rota.' });

  const resolved = await resolveByNumber(numero);
  if (!resolved.ok) return res.status(200).json({ status: resolved.notFound ? 'not_found' : 'error', stage: resolved.stage, delete_attempted: false, delete_succeeded: false, numero, betel_http_status: resolved.betel_http_status ?? null, betel_details: resolved.betel_details ?? null, message: resolved.message ?? null });

  const snapshot = {
    codigo: String(resolved.proposal?.codigo ?? numero), cliente_id: resolved.proposal?.cliente_id ?? null,
    nome_cliente: resolved.proposal?.nome_cliente ?? null, valor_total: resolved.proposal?.valor_total ?? null,
    data: resolved.proposal?.data ?? null, previsao_entrega: resolved.proposal?.previsao_entrega ?? null,
    situacao_id: resolved.proposal?.situacao_id ?? null, nome_situacao: resolved.proposal?.nome_situacao ?? null
  };

  let deleteResponse;
  try { deleteResponse = await betel(`/orcamentos/${encodeURIComponent(resolved.id)}`, { method: 'DELETE' }); }
  catch (err) { return res.status(200).json({ status: 'error', stage: 'betel_delete_transport', delete_attempted: true, delete_succeeded: false, numero, proposal_before_delete: snapshot, message: err.message }); }
  if (!deleteResponse.ok) return res.status(200).json({ status: 'error', stage: 'betel_delete', delete_attempted: true, delete_succeeded: false, numero, proposal_before_delete: snapshot, betel_http_status: deleteResponse.status, betel_details: compactDetails(deleteResponse.data) });

  let verification;
  try { verification = await resolveByNumber(numero); }
  catch (err) { return res.status(200).json({ status: 'success_unverified', stage: 'verification_transport', delete_attempted: true, delete_succeeded: true, verification_succeeded: false, numero, proposal_before_delete: snapshot, message: err.message }); }

  if (verification.ok) return res.status(200).json({ status: 'success_with_verification_warning', stage: 'verification', delete_attempted: true, delete_succeeded: true, verification_succeeded: false, proposal_absent_after_delete: false, numero, proposal_before_delete: snapshot, message: 'Betel confirmou a exclusao, mas a proposta ainda foi localizada pelo numero. Nao repetir DELETE sem nova analise.' });
  if (!verification.notFound) return res.status(200).json({ status: 'success_unverified', stage: verification.stage || 'verification', delete_attempted: true, delete_succeeded: true, verification_succeeded: false, numero, proposal_before_delete: snapshot, message: verification.message ?? 'A verificacao posterior falhou; nao repetir DELETE automaticamente.' });

  return res.status(200).json({ status: 'success', stage: 'completed', delete_attempted: true, delete_succeeded: true, verification_succeeded: true, proposal_absent_after_delete: true, numero, proposal_before_delete: snapshot, connector_write_mode: 'direct_betel_number_resolution' });
}

express.application.use = function patchedNumberWriteUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!routesInstalled && proxyFn?.name === 'proxyToLegacy') {
    routesInstalled = true;
    originalPut.call(this, '/erp/orcamentos/numero/:numero', editByNumberHandler);
    originalDelete.call(this, '/erp/orcamentos/numero/:numero', deleteByNumberHandler);
    console.log('Installed proposal edit/delete routes by commercial number before legacy proxy');
  }
  return originalUse.apply(this, args);
};
