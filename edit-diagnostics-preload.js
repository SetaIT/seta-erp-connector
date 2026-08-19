import express from 'express';

const originalUse = express.application.use;
const originalPut = express.application.put;
let diagnosticsRouteInstalled = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;

const EDITABLE_FIELDS = [
  'data',
  'validade',
  'situacao_id',
  'vendedor_id',
  'previsao_entrega',
  'prazo_entrega',
  'valor_frete',
  'introducao',
  'observacoes',
  'observacoes_interna'
];

// Betel documents PUT /orcamentos/{id} as a full proposal update. Existing proposals
// can contain finance/items that are validated again even when the user changes only
// a non-financial field. Preserve the current state instead of sending only the five
// required fields plus the requested change.
const PRESERVED_UPDATE_FIELDS = [
  'nome_cliente',
  'vendedor_id',
  'nome_vendedor',
  'tecnico_id',
  'nome_tecnico',
  'previsao_entrega',
  'nome_situacao',
  'valor_total',
  'nome_transportadora',
  'transportadora_id',
  'centro_custo_id',
  'aos_cuidados_de',
  'validade',
  'introducao',
  'observacoes',
  'observacoes_interna',
  'nome_canal_venda',
  'nome_loja',
  'valor_frete',
  'desconto_valor',
  'desconto_porcentagem',
  'tipo_desconto',
  'condicao_pagamento',
  'forma_pagamento_id',
  'data_primeira_parcela',
  'numero_parcelas',
  'intervalo_dias',
  'pagamentos',
  'produtos',
  'servicos'
];

const STABILITY_FIELDS = [
  'cliente_id',
  'situacao_id',
  'vendedor_id',
  'valor_total',
  'valor_frete',
  'condicao_pagamento',
  'forma_pagamento_id',
  'numero_parcelas',
  'data_primeira_parcela',
  'intervalo_dias',
  'pagamentos',
  'produtos',
  'servicos'
];

function compactDetails(value, maxLength = 3000) {
  if (value === undefined || value === null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}...`;
  try { return JSON.parse(text); } catch { return text; }
}

function parseDateToIso(value, fieldName) {
  if (value === null) return null;
  const raw = String(value || '').trim();
  let year;
  let month;
  let day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    [year, month, day] = raw.split('-').map(Number);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    [day, month, year] = raw.split('/').map(Number);
  } else {
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

function proposalData(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
  return payload && typeof payload === 'object' ? payload : null;
}

function inferProposalType(current) {
  if (current?.tipo) return current.tipo;
  const hasProducts = Array.isArray(current?.produtos) && current.produtos.length > 0;
  const hasServices = Array.isArray(current?.servicos) && current.servicos.length > 0;
  if (!hasProducts && hasServices) return 'servico';
  return 'produto';
}

function currentRequired(current, field) {
  const value = current?.[field];
  if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  const err = new Error(`Campo obrigatorio ${field} ausente na proposta atual`);
  err.stage = 'prepare_payload';
  err.field = field;
  throw err;
}

function copyPreservedFields(current) {
  const preserved = {};
  for (const field of PRESERVED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current || {}, field)) preserved[field] = current[field];
  }
  return preserved;
}

function buildPayload(current, body) {
  if (body?.confirmacao_edicao !== true) {
    const err = new Error('confirmacao_edicao deve ser true apos preview e confirmacao explicita');
    err.stage = 'prepare_payload';
    err.field = 'confirmacao_edicao';
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

  const codigoRaw = currentRequired(current, 'codigo');
  const codigo = Number(codigoRaw);
  if (!Number.isInteger(codigo)) {
    const err = new Error('codigo atual da proposta nao e um inteiro valido');
    err.stage = 'prepare_payload';
    err.field = 'codigo';
    throw err;
  }

  const preserved = copyPreservedFields(current);
  const payload = {
    tipo: inferProposalType(current),
    codigo,
    cliente_id: currentRequired(current, 'cliente_id'),
    situacao_id: currentRequired(current, 'situacao_id'),
    data: parseDateToIso(currentRequired(current, 'data'), 'data'),
    ...preserved,
    ...changes
  };

  // Required values must always win over any stale duplicated response property.
  payload.codigo = codigo;
  payload.cliente_id = currentRequired(current, 'cliente_id');
  payload.situacao_id = Object.prototype.hasOwnProperty.call(changes, 'situacao_id') ? changes.situacao_id : currentRequired(current, 'situacao_id');
  payload.data = Object.prototype.hasOwnProperty.call(changes, 'data') ? changes.data : parseDateToIso(currentRequired(current, 'data'), 'data');
  payload.tipo = inferProposalType(current);

  return { payload, changes, preservedFields: Object.keys(preserved) };
}

function valuesForFields(source, fields) {
  const output = {};
  for (const field of fields) output[field] = source?.[field] ?? null;
  return output;
}

function stableJson(value) {
  if (value === undefined) return '__undefined__';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stabilityCheck(before, after, changedFields) {
  const changed = new Set(changedFields);
  const checked = [];
  const unexpected = [];
  for (const field of STABILITY_FIELDS) {
    if (changed.has(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(before || {}, field) && !Object.prototype.hasOwnProperty.call(after || {}, field)) continue;
    checked.push(field);
    if (stableJson(before?.[field]) !== stableJson(after?.[field])) {
      unexpected.push({ field, before: compactDetails(before?.[field], 1000), after: compactDetails(after?.[field], 1000) });
    }
  }
  return { checked, unexpected };
}

function financeSummary(source) {
  const payments = Array.isArray(source?.pagamentos) ? source.pagamentos : [];
  const paymentValues = payments.map(item => item?.pagamento?.valor).filter(value => value !== undefined && value !== null);
  return {
    valor_total: source?.valor_total ?? null,
    valor_frete: source?.valor_frete ?? null,
    condicao_pagamento: source?.condicao_pagamento ?? null,
    forma_pagamento_id: source?.forma_pagamento_id ?? null,
    numero_parcelas: source?.numero_parcelas ?? null,
    pagamentos_count: payments.length,
    pagamentos_valores: paymentValues
  };
}

async function editDiagnosticsHandler(req, res) {
  const id = String(req.params.id || '').trim();
  if (!CONNECTOR_API_KEY || req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) {
    return res.status(401).json({ status: 'error', stage: 'authentication', write_attempted: false, write_succeeded: false, message: 'unauthorized' });
  }
  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN) {
    return res.status(200).json({ status: 'error', stage: 'configuration', write_attempted: false, write_succeeded: false, message: 'Credenciais Betel nao configuradas no Railway.' });
  }

  let current;
  let changes;
  let payload;
  let preservedFields = [];

  try {
    const currentResponse = await betel(`/orcamentos/${encodeURIComponent(id)}`);
    if (!currentResponse.ok) {
      return res.status(200).json({
        status: 'error',
        stage: 'load_current_proposal',
        write_attempted: false,
        write_succeeded: false,
        betel_http_status: currentResponse.status,
        betel_details: compactDetails(currentResponse.data)
      });
    }
    current = proposalData(currentResponse.data);
    if (!current) {
      return res.status(200).json({ status: 'error', stage: 'load_current_proposal', write_attempted: false, write_succeeded: false, message: 'Resposta do Betel sem proposta interpretavel.' });
    }

    ({ payload, changes, preservedFields } = buildPayload(current, req.body || {}));
  } catch (err) {
    return res.status(200).json({
      status: 'error',
      stage: err.stage || 'prepare_payload',
      write_attempted: false,
      write_succeeded: false,
      field: err.field || null,
      message: err.message
    });
  }

  let updateResponse;
  try {
    updateResponse = await betel(`/orcamentos/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
  } catch (err) {
    return res.status(200).json({
      status: 'error',
      stage: 'betel_update_transport',
      write_attempted: true,
      write_succeeded: false,
      message: err.message
    });
  }

  if (!updateResponse.ok) {
    return res.status(200).json({
      status: 'error',
      stage: 'betel_update',
      write_attempted: true,
      write_succeeded: false,
      betel_http_status: updateResponse.status,
      requested_changes: changes,
      preserved_fields: preservedFields,
      current_finance_summary: financeSummary(current),
      payload_summary: {
        tipo: payload.tipo,
        codigo: payload.codigo,
        cliente_id: String(payload.cliente_id),
        situacao_id: String(payload.situacao_id),
        data: payload.data,
        changed_fields: Object.keys(changes),
        produtos_count: Array.isArray(payload.produtos) ? payload.produtos.length : 0,
        servicos_count: Array.isArray(payload.servicos) ? payload.servicos.length : 0,
        pagamentos_count: Array.isArray(payload.pagamentos) ? payload.pagamentos.length : 0
      },
      betel_details: compactDetails(updateResponse.data)
    });
  }

  let verificationResponse;
  try {
    verificationResponse = await betel(`/orcamentos/${encodeURIComponent(id)}`);
  } catch (err) {
    return res.status(200).json({
      status: 'success_unverified',
      stage: 'verification_transport',
      write_attempted: true,
      write_succeeded: true,
      verification_succeeded: false,
      requested_changes: changes,
      message: err.message
    });
  }

  if (!verificationResponse.ok) {
    return res.status(200).json({
      status: 'success_unverified',
      stage: 'verification',
      write_attempted: true,
      write_succeeded: true,
      verification_succeeded: false,
      betel_http_status: verificationResponse.status,
      requested_changes: changes,
      betel_details: compactDetails(verificationResponse.data)
    });
  }

  const refreshed = proposalData(verificationResponse.data);
  const stability = stabilityCheck(current, refreshed, Object.keys(changes));
  const afterRequested = valuesForFields(refreshed, Object.keys(changes));
  const requestedMatched = Object.entries(changes).every(([field, value]) => stableJson(afterRequested[field]) === stableJson(value));

  return res.status(200).json({
    status: requestedMatched && stability.unexpected.length === 0 ? 'success' : 'success_with_verification_warning',
    stage: 'completed',
    write_attempted: true,
    write_succeeded: true,
    verification_succeeded: true,
    requested_changes_matched: requestedMatched,
    unrelated_state_preserved: stability.unexpected.length === 0,
    id,
    codigo: refreshed?.codigo ?? current?.codigo ?? null,
    changed_fields: Object.keys(changes),
    preserved_fields_sent: preservedFields,
    stability_fields_checked: stability.checked,
    unexpected_changes: stability.unexpected,
    before: valuesForFields(current, Object.keys(changes)),
    requested: changes,
    after: afterRequested,
    finance_before: financeSummary(current),
    finance_after: financeSummary(refreshed)
  });
}

express.application.use = function patchedUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!diagnosticsRouteInstalled && proxyFn?.name === 'proxyToLegacy') {
    diagnosticsRouteInstalled = true;
    originalPut.call(this, '/erp/orcamentos/:id', editDiagnosticsHandler);
    console.log('Installed staged proposal edit diagnostics route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
