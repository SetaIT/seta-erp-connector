function parseIsoDate(value, fieldName = 'data') {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} deve estar no formato YYYY-MM-DD`);
  }
  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${fieldName} invalida`);
  }
  return date;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + Number(days || 0));
  return result;
}

function paymentSource(body) {
  const rows = Array.isArray(body?.pagamentos) ? body.pagamentos : [];
  const first = rows[0];
  if (!first || typeof first !== 'object') return {};
  return first.pagamento && typeof first.pagamento === 'object' ? first.pagamento : first;
}

function cleanPaymentRow(source, { dueDate, total, paymentMethodId }) {
  const row = {
    data_vencimento: dueDate,
    valor: Number(total).toFixed(2)
  };
  const forma = paymentMethodId ?? source?.forma_pagamento_id;
  if (forma !== undefined && forma !== null && String(forma).trim() !== '') row.forma_pagamento_id = String(forma);
  if (source?.plano_contas_id !== undefined && source?.plano_contas_id !== null && String(source.plano_contas_id).trim() !== '') {
    row.plano_contas_id = source.plano_contas_id;
  }
  if (source?.observacao !== undefined && source?.observacao !== null && String(source.observacao).trim() !== '') {
    row.observacao = String(source.observacao);
  }
  return row;
}

export function applyConfiguredPaymentTerms({ body, total, paymentTerms }) {
  const source = body && typeof body === 'object' ? body : {};
  const result = { ...source };
  if (!paymentTerms || typeof paymentTerms !== 'object') {
    return { body: result, applied: false, metadata: null };
  }

  const installmentCount = Number(paymentTerms.numero_parcelas || 1);
  if (!Number.isInteger(installmentCount) || installmentCount !== 1) {
    throw new Error('A regra automática atual suporta exatamente 1 parcela para este tipo de proposta');
  }

  const numericTotal = Number(total);
  if (!Number.isFinite(numericTotal) || numericTotal < 0) {
    throw new Error('valor total invalido para aplicar a regra de pagamento');
  }

  const baseDate = parseIsoDate(source.data, 'data');
  const dueDays = Number(paymentTerms.vencimento_dias_apos_data_proposta || 0);
  if (!Number.isInteger(dueDays) || dueDays < 0) {
    throw new Error('vencimento_dias_apos_data_proposta invalido');
  }
  const dueDate = formatIsoDate(addDaysUtc(baseDate, dueDays));

  result.condicao_pagamento = String(paymentTerms.condicao_pagamento || result.condicao_pagamento || '');
  result.numero_parcelas = String(installmentCount);
  result.data_primeira_parcela = dueDate;
  result.intervalo_dias = '0';
  result.exibir_pagamento = paymentTerms.exibir_pagamento === false ? '0' : '1';

  const existing = paymentSource(source);
  const paymentMethodId = source.forma_pagamento_id ?? existing.forma_pagamento_id;
  if (paymentMethodId !== undefined && paymentMethodId !== null && String(paymentMethodId).trim() !== '') {
    result.forma_pagamento_id = String(paymentMethodId);
    result.pagamentos = [{
      pagamento: cleanPaymentRow(existing, {
        dueDate,
        total: numericTotal,
        paymentMethodId
      })
    }];
  } else if (Array.isArray(source.pagamentos) && source.pagamentos.length > 0) {
    result.pagamentos = [{
      pagamento: cleanPaymentRow(existing, {
        dueDate,
        total: numericTotal,
        paymentMethodId: null
      })
    }];
  }

  return {
    body: result,
    applied: true,
    metadata: {
      condicao_pagamento: result.condicao_pagamento,
      numero_parcelas: installmentCount,
      data_primeira_parcela: dueDate,
      intervalo_dias: 0,
      exibir_pagamento: result.exibir_pagamento === '1',
      pagamentos_normalizados: Array.isArray(result.pagamentos),
      valor_parcela: numericTotal.toFixed(2)
    }
  };
}
