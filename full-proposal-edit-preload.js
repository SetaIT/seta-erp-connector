import express from 'express';

const originalUse = express.application.use;
const originalPut = express.application.put;
let installed = false;

const BETEL_BASE_URL = process.env.BETEL_BASE_URL || 'https://api.beteltecnologia.com/api';
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const BETEL_ACCESS_TOKEN = process.env.BETEL_ACCESS_TOKEN;
const BETEL_SECRET_ACCESS_TOKEN = process.env.BETEL_SECRET_ACCESS_TOKEN;

const allowed = ['data', 'validade', 'situacao_id', 'vendedor_id', 'previsao_entrega', 'prazo_entrega', 'valor_frete', 'condicao_pagamento', 'forma_pagamento_id', 'data_primeira_parcela', 'numero_parcelas', 'intervalo_dias', 'pagamentos', 'introducao', 'observacoes', 'observacoes_interna', 'produtos', 'servicos', 'tipo', 'tipo_proposta', 'solucao', 'meses'];

const unwrap = value => value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
const authorized = req => Boolean(CONNECTOR_API_KEY && req.headers.authorization === `Bearer ${CONNECTOR_API_KEY}`);

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

async function editFullProposal(req, res) {
  if (!authorized(req)) return res.status(401).json({ message: 'unauthorized' });
  if (!BETEL_ACCESS_TOKEN || !BETEL_SECRET_ACCESS_TOKEN) return res.status(503).json({ message: 'Credenciais Betel não configuradas.' });
  if (req.body?.confirmacao_edicao !== true) return res.status(400).json({ message: 'Confirmação de edição obrigatória.' });

  const id = encodeURIComponent(req.params.id);
  const currentResponse = await betel(`/orcamentos/${id}`);
  const current = unwrap(currentResponse.data);
  if (!currentResponse.ok || !current || typeof current !== 'object') return res.status(currentResponse.status || 502).json({ message: 'Não foi possível carregar a proposta atual.' });

  const changes = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(req.body || {}, key)).map(key => [key, req.body[key]]));
  if (!Object.keys(changes).length) return res.status(400).json({ message: 'Informe ao menos um campo para atualizar.' });

  const payload = {
    tipo: current.tipo || 'produto',
    codigo: current.codigo,
    cliente_id: current.cliente_id,
    situacao_id: current.situacao_id,
    data: current.data,
    ...changes
  };
  const updated = await betel(`/orcamentos/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (!updated.ok) return res.status(updated.status).json({ message: 'O ERP recusou a atualização.', details: updated.data });
  return res.json({ status: 'success', action: 'proposal_updated', id: req.params.id, codigo: payload.codigo, changes_requested: Object.keys(changes), proposal: updated.data });
}

express.application.use = function patchedFullEditUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!installed && proxyFn?.name === 'proxyToLegacy') {
    installed = true;
    originalPut.call(this, '/erp/orcamentos/:id', editFullProposal);
  }
  return originalUse.apply(this, args);
};
