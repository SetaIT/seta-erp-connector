function collection(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'dados', 'results', 'orcamentos', 'items', 'registros']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function objectPayload(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
  return payload && typeof payload === 'object' ? payload : null;
}

function findByNumber(payload, number) {
  const target = String(number);
  const item = collection(payload).find(row => String(row?.codigo ?? row?.numero ?? row?.numero_proposta ?? row?.codigo_orcamento ?? '') === target);
  if (item) return item;
  const single = objectPayload(payload);
  const code = single?.codigo ?? single?.numero ?? single?.numero_proposta ?? single?.codigo_orcamento;
  return String(code ?? '') === target ? single : null;
}

function validNumber(number) {
  return /^\d+$/.test(String(number || '').trim());
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function equal(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

const EDITABLE_FIELDS = new Set([
  'data', 'validade', 'situacao_id', 'vendedor_id', 'previsao_entrega',
  'prazo_entrega', 'valor_frete', 'introducao', 'observacoes', 'observacoes_interna'
]);

const PRESERVED_FIELDS = [
  'nome_cliente', 'vendedor_id', 'nome_vendedor', 'tecnico_id', 'nome_tecnico',
  'previsao_entrega', 'nome_situacao', 'valor_total', 'nome_transportadora',
  'transportadora_id', 'centro_custo_id', 'aos_cuidados_de', 'validade',
  'introducao', 'observacoes', 'observacoes_interna', 'nome_canal_venda',
  'nome_loja', 'valor_frete', 'desconto_valor', 'desconto_porcentagem',
  'tipo_desconto', 'condicao_pagamento', 'forma_pagamento_id',
  'data_primeira_parcela', 'numero_parcelas', 'intervalo_dias', 'pagamentos',
  'produtos', 'servicos'
];

function required(current, field) {
  const value = current?.[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    const error = new Error(`Campo obrigatorio ${field} ausente na proposta atual`);
    error.field = field;
    throw error;
  }
  return value;
}

function inferType(current) {
  if (current?.tipo) return current.tipo;
  if ((!Array.isArray(current?.produtos) || current.produtos.length === 0) && Array.isArray(current?.servicos) && current.servicos.length > 0) return 'servico';
  return 'produto';
}

function buildUpdatePayload(current, changes) {
  const preserved = {};
  for (const field of PRESERVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current || {}, field)) preserved[field] = current[field];
  }
  return {
    tipo: inferType(current),
    codigo: Number(required(current, 'codigo')),
    cliente_id: required(current, 'cliente_id'),
    situacao_id: required(current, 'situacao_id'),
    data: required(current, 'data'),
    ...preserved,
    ...changes
  };
}

export class ProposalService {
  constructor(betel) {
    this.betel = betel;
  }

  async resolveByNumber(number) {
    const numero = String(number || '').trim();
    if (!validNumber(numero)) {
      return { ok: false, result: { status: 'error', stage: 'validation', read_succeeded: false, numero, message: 'numero da proposta deve ser numerico' } };
    }

    let lookup;
    try {
      lookup = await this.betel.get(`/orcamentos?codigo=${encodeURIComponent(numero)}`);
    } catch (error) {
      return { ok: false, result: { status: 'error', stage: 'resolve_number_transport', read_succeeded: false, numero, message: error.message, code: error.code || null } };
    }
    if (!lookup.ok) {
      return { ok: false, result: { status: 'error', stage: 'resolve_number', read_succeeded: false, numero, betel_http_status: lookup.status, betel_details: lookup.data } };
    }

    const summary = findByNumber(lookup.data, numero);
    const id = String(summary?.id ?? summary?.orcamento_id ?? summary?.id_orcamento ?? '').trim();
    if (!summary || !id) {
      return { ok: false, result: { status: 'not_found', stage: 'resolve_number', read_succeeded: false, numero, message: 'Proposta nao encontrada pelo numero comercial.' } };
    }

    let detail;
    try {
      detail = await this.betel.get(`/orcamentos/${encodeURIComponent(id)}`);
    } catch (error) {
      return { ok: false, result: { status: 'error', stage: 'load_proposal_transport', read_succeeded: false, numero, message: error.message, code: error.code || null } };
    }
    if (!detail.ok) {
      return { ok: false, result: { status: 'error', stage: 'load_proposal', read_succeeded: false, numero, betel_http_status: detail.status, betel_details: detail.data } };
    }

    const proposal = objectPayload(detail.data);
    if (String(proposal?.codigo ?? '') !== numero) {
      return { ok: false, result: { status: 'error', stage: 'identity_mismatch', read_succeeded: false, numero, codigo_retornado: proposal?.codigo ?? null } };
    }
    return { ok: true, numero, id, proposal };
  }

  async getByNumber(number) {
    const resolved = await this.resolveByNumber(number);
    if (!resolved.ok) return resolved.result;
    const { numero, id, proposal } = resolved;
    return {
      status: 'success', stage: 'completed', read_succeeded: true, numero,
      codigo: proposal.codigo, nome_cliente: proposal.nome_cliente ?? null,
      cliente_id: proposal.cliente_id ?? null, valor_total: proposal.valor_total ?? null,
      data: proposal.data ?? null, validade: proposal.validade ?? null,
      previsao_entrega: proposal.previsao_entrega ?? null, prazo_entrega: proposal.prazo_entrega ?? null,
      situacao_id: proposal.situacao_id ?? null, nome_situacao: proposal.nome_situacao ?? null,
      hash: proposal.hash ?? null, _internal: { id }
    };
  }

  async editByNumber(number, changes, { confirmed = false } = {}) {
    const numero = String(number || '').trim();
    if (!confirmed) return { status: 'error', stage: 'confirmation', write_attempted: false, write_succeeded: false, numero, message: 'confirmacao_edicao obrigatoria' };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
      return { status: 'error', stage: 'validation', write_attempted: false, write_succeeded: false, numero, message: 'informe ao menos uma alteracao' };
    }
    const invalid = Object.keys(changes).filter(field => !EDITABLE_FIELDS.has(field));
    if (invalid.length) return { status: 'error', stage: 'validation', write_attempted: false, write_succeeded: false, numero, invalid_fields: invalid };

    const resolved = await this.resolveByNumber(numero);
    if (!resolved.ok) return { ...resolved.result, write_attempted: false, write_succeeded: false };

    let payload;
    try { payload = buildUpdatePayload(resolved.proposal, changes); }
    catch (error) { return { status: 'error', stage: 'prepare_payload', write_attempted: false, write_succeeded: false, numero, field: error.field || null, message: error.message }; }

    let write;
    try { write = await this.betel.put(`/orcamentos/${encodeURIComponent(resolved.id)}`, payload); }
    catch (error) { return { status: 'error', stage: 'betel_update_transport', write_attempted: true, write_succeeded: false, numero, message: error.message }; }
    if (!write.ok) return { status: 'error', stage: 'betel_update', write_attempted: true, write_succeeded: false, numero, betel_http_status: write.status, betel_details: write.data };

    const verified = await this.resolveByNumber(numero);
    if (!verified.ok) return { status: 'success_unverified', stage: 'verification', write_attempted: true, write_succeeded: true, verification_succeeded: false, numero };

    const after = Object.fromEntries(Object.keys(changes).map(field => [field, verified.proposal?.[field] ?? null]));
    const matched = Object.entries(changes).every(([field, value]) => equal(after[field], value));
    return {
      status: matched ? 'success' : 'success_with_verification_warning',
      stage: 'completed', write_attempted: true, write_succeeded: true, verification_succeeded: true,
      requested_changes_matched: matched, numero, before: Object.fromEntries(Object.keys(changes).map(field => [field, resolved.proposal?.[field] ?? null])),
      requested: changes, after
    };
  }

  async deleteByNumber(number, { confirmed = false, confirmationCode = '' } = {}) {
    const numero = String(number || '').trim();
    if (!confirmed) return { status: 'error', stage: 'confirmation', delete_attempted: false, delete_succeeded: false, numero, message: 'confirmacao_exclusao obrigatoria' };
    if (String(confirmationCode).trim() !== numero) return { status: 'error', stage: 'confirmation_mismatch', delete_attempted: false, delete_succeeded: false, numero };

    const resolved = await this.resolveByNumber(numero);
    if (!resolved.ok) return { ...resolved.result, delete_attempted: false, delete_succeeded: false };

    const snapshot = {
      codigo: resolved.proposal.codigo,
      nome_cliente: resolved.proposal.nome_cliente ?? null,
      cliente_id: resolved.proposal.cliente_id ?? null,
      valor_total: resolved.proposal.valor_total ?? null,
      data: resolved.proposal.data ?? null,
      situacao_id: resolved.proposal.situacao_id ?? null
    };

    let write;
    try { write = await this.betel.delete(`/orcamentos/${encodeURIComponent(resolved.id)}`); }
    catch (error) { return { status: 'error', stage: 'betel_delete_transport', delete_attempted: true, delete_succeeded: false, numero, proposal_before_delete: snapshot, message: error.message }; }
    if (!write.ok) return { status: 'error', stage: 'betel_delete', delete_attempted: true, delete_succeeded: false, numero, proposal_before_delete: snapshot, betel_http_status: write.status, betel_details: write.data };

    const verified = await this.resolveByNumber(numero);
    if (verified.ok) return { status: 'success_with_verification_warning', stage: 'verification', delete_attempted: true, delete_succeeded: true, verification_succeeded: false, proposal_absent_after_delete: false, numero, proposal_before_delete: snapshot };
    if (verified.result?.status !== 'not_found') return { status: 'success_unverified', stage: 'verification', delete_attempted: true, delete_succeeded: true, verification_succeeded: false, numero, proposal_before_delete: snapshot };

    return { status: 'success', stage: 'completed', delete_attempted: true, delete_succeeded: true, verification_succeeded: true, proposal_absent_after_delete: true, numero, proposal_before_delete: snapshot };
  }
}
