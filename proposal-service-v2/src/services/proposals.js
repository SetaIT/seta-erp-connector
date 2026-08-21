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

export class ProposalService {
  constructor(betel) {
    this.betel = betel;
  }

  async getByNumber(number) {
    const numero = String(number || '').trim();
    if (!/^\d+$/.test(numero)) {
      return { status: 'error', stage: 'validation', read_succeeded: false, numero, message: 'numero da proposta deve ser numerico' };
    }

    let lookup;
    try {
      lookup = await this.betel.get(`/orcamentos?codigo=${encodeURIComponent(numero)}`);
    } catch (error) {
      return { status: 'error', stage: 'resolve_number_transport', read_succeeded: false, numero, message: error.message, code: error.code || null };
    }

    if (!lookup.ok) {
      return { status: 'error', stage: 'resolve_number', read_succeeded: false, numero, betel_http_status: lookup.status, betel_details: lookup.data };
    }

    const summary = findByNumber(lookup.data, numero);
    const id = String(summary?.id ?? summary?.orcamento_id ?? summary?.id_orcamento ?? '').trim();
    if (!summary || !id) {
      return { status: 'not_found', stage: 'resolve_number', read_succeeded: false, numero, message: 'Proposta nao encontrada pelo numero comercial.' };
    }

    let detail;
    try {
      detail = await this.betel.get(`/orcamentos/${encodeURIComponent(id)}`);
    } catch (error) {
      return { status: 'error', stage: 'load_proposal_transport', read_succeeded: false, numero, message: error.message, code: error.code || null };
    }

    if (!detail.ok) {
      return { status: 'error', stage: 'load_proposal', read_succeeded: false, numero, betel_http_status: detail.status, betel_details: detail.data };
    }

    const proposal = objectPayload(detail.data);
    if (String(proposal?.codigo ?? '') !== numero) {
      return { status: 'error', stage: 'identity_mismatch', read_succeeded: false, numero, codigo_retornado: proposal?.codigo ?? null };
    }

    return {
      status: 'success',
      stage: 'completed',
      read_succeeded: true,
      numero,
      codigo: proposal.codigo,
      nome_cliente: proposal.nome_cliente ?? null,
      cliente_id: proposal.cliente_id ?? null,
      valor_total: proposal.valor_total ?? null,
      data: proposal.data ?? null,
      validade: proposal.validade ?? null,
      previsao_entrega: proposal.previsao_entrega ?? null,
      prazo_entrega: proposal.prazo_entrega ?? null,
      situacao_id: proposal.situacao_id ?? null,
      nome_situacao: proposal.nome_situacao ?? null,
      hash: proposal.hash ?? null,
      _internal: { id }
    };
  }
}
