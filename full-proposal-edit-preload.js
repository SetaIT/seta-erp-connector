import express from 'express';

const originalUse = express.application.use;
const originalPut = express.application.put;
let installed = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;

const allowed = [
  'data',
  'validade',
  'situacao_id',
  'cliente_id',
  'nome_cliente',
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
  'observacoes_interna',
  'produtos',
  'servicos',
  'tipo',
  'tipo_proposta',
  'solucao',
  'meses'
];

// Betel validates the whole proposal on PUT. Even for an administrative edit,
// products, services and payment rows must remain in the payload; otherwise the
// ERP can compare the existing installments against an incomplete order total.
const preservedUpdateFields = [
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

const unwrap = value => value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
const authorized = req => Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

async function betel(path, init = {}) {
  const response = await fetch(`${BETEL_BASE_URL}${path}`, {
    ...init,
    headers: {
      'access-token': BETEL_ACCESS_TOKEN,
      'secret-access-token': BETEL_SECRET_ACCESS_TOKEN,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

function inferProposalType(current, requested) {
  const requestedType = String(requested || '').trim().toLowerCase();
  if (requestedType === 'produto' || requestedType === 'servico') return requestedType;
  const currentType = String(current?.tipo || '').trim().toLowerCase();
  if (currentType === 'produto' || currentType === 'servico') return currentType;
  const hasProducts = Array.isArray(current?.produtos) && current.produtos.length > 0;
  const hasServices = Array.isArray(current?.servicos) && current.servicos.length > 0;
  return !hasProducts && hasServices ? 'servico' : 'produto';
}

function required(current, field) {
  const value = current?.[field];
  if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  const error = new Error(`Campo obrigatório ${field} ausente na proposta atual.`);
  error.field = field;
  throw error;
}

function buildPayload(current, requestBody) {
  const changes = Object.fromEntries(
    allowed
      .filter(key => hasOwn(requestBody, key))
      .map(key => [key, requestBody[key]])
  );
  if (!Object.keys(changes).length) {
    const error = new Error('Informe ao menos um campo para atualizar.');
    error.field = 'changes';
    throw error;
  }

  // The app's commercial type is compra/locacao/spareparts and belongs in
  // tipo_proposta. Betel's tipo field is only produto/servico.
  if (hasOwn(changes, 'tipo')) {
    const requestedType = String(changes.tipo || '').trim().toLowerCase();
    if (requestedType !== 'produto' && requestedType !== 'servico') delete changes.tipo;
  }

  const itemStructureChanged = hasOwn(changes, 'produtos') || hasOwn(changes, 'servicos');
  const preserved = {};
  for (const field of preservedUpdateFields) {
    // Let Betel recalculate the total when the item structure changes.
    if (itemStructureChanged && field === 'valor_total') continue;
    if (hasOwn(current, field)) preserved[field] = current[field];
  }

  const payload = {
    tipo: inferProposalType(current, changes.tipo),
    codigo: required(current, 'codigo'),
    cliente_id: hasOwn(changes, 'cliente_id') ? changes.cliente_id : required(current, 'cliente_id'),
    situacao_id: hasOwn(changes, 'situacao_id') ? changes.situacao_id : required(current, 'situacao_id'),
    data: hasOwn(changes, 'data') ? changes.data : required(current, 'data'),
    ...preserved,
    ...changes
  };

  payload.tipo = inferProposalType(current, changes.tipo);
  payload.codigo = required(current, 'codigo');
  payload.cliente_id = hasOwn(changes, 'cliente_id') ? changes.cliente_id : required(current, 'cliente_id');
  payload.situacao_id = hasOwn(changes, 'situacao_id') ? changes.situacao_id : required(current, 'situacao_id');
  payload.data = hasOwn(changes, 'data') ? changes.data : required(current, 'data');

  return {
    payload,
    changes,
    preservedFields: Object.keys(preserved)
  };
}

async function editFullProposal(req, res) {
  if (!authorized(req)) return res.status(401).json({ message: 'unauthorized' });
  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN) return res.status(503).json({ message: 'Credenciais Betel não configuradas.' });
  if (req.body?.confirmacao_edicao !== true) return res.status(400).json({ message: 'Confirmação de edição obrigatória.' });

  const id = encodeURIComponent(req.params.id);
  const currentResponse = await betel(`/orcamentos/${id}`);
  const current = unwrap(currentResponse.data);
  if (!currentResponse.ok || !current || typeof current !== 'object') {
    return res.status(currentResponse.status || 502).json({ message: 'Não foi possível carregar a proposta atual.', details: currentResponse.data });
  }

  let built;
  try {
    built = buildPayload(current, req.body || {});
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Não foi possível preparar a atualização.',
      field: error?.field || null
    });
  }

  const updated = await betel(`/orcamentos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(built.payload)
  });
  if (!updated.ok) {
    return res.status(updated.status).json({
      message: 'O ERP recusou a atualização.',
      details: updated.data,
      changes_requested: Object.keys(built.changes),
      preserved_fields: built.preservedFields
    });
  }

  const verificationResponse = await betel(`/orcamentos/${id}`);
  const verifiedProposal = unwrap(verificationResponse.data);
  const confirmed = Boolean(
    verificationResponse.ok &&
    verifiedProposal &&
    typeof verifiedProposal === 'object' &&
    String(verifiedProposal.id ?? verifiedProposal.orcamento_id ?? req.params.id) === String(req.params.id)
  );

  return res.json({
    status: 'success',
    action: 'proposal_updated',
    id: req.params.id,
    codigo: built.payload.codigo,
    changes_requested: Object.keys(built.changes),
    preserved_fields: built.preservedFields,
    proposal: updated.data,
    verification: {
      confirmed,
      proposal: confirmed ? verifiedProposal : null
    }
  });
}

express.application.use = function patchedFullEditUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!installed && proxyFn?.name === 'proxyToLegacy') {
    installed = true;
    originalPut.call(this, '/erp/orcamentos/:id', editFullProposal);
    console.log('Installed payment-safe full proposal edit route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
