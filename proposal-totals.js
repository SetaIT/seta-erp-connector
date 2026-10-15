function invalid(field) {
  return Object.assign(new Error(`${field} invalido para calcular o total da proposta`), {
    status: 400, source: 'request', data: { field },
  });
}

function numeric(value, field, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  let raw = String(value).trim().replace(/\s|R\$|US\$/gi, '');
  if (raw.includes(',') && raw.includes('.')) raw = raw.replace(/\./g, '').replace(',', '.');
  else raw = raw.replace(',', '.');
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) throw invalid(field);
  return number;
}

const cents = (amount) => Math.round((amount + Number.EPSILON) * 100);

/** Sum the net value of each ERP line, rounded to cents. Freight is informational. */
export function calculateProposalTotal({ produtos = [], servicos = [] } = {}) {
  if (!Array.isArray(produtos) || !Array.isArray(servicos) || !produtos.length && !servicos.length) {
    throw invalid('produtos/servicos');
  }
  let totalCents = 0;
  for (const [kind, rows] of [['produto', produtos], ['servico', servicos]]) {
    rows.forEach((entry, index) => {
      const line = entry?.[kind] || entry;
      if (!line || typeof line !== 'object') throw invalid(`${kind}[${index}]`);
      const field = `${kind}[${index}]`;
      const quantity = numeric(line.quantidade, `${field}.quantidade`, 1);
      const price = numeric(line.valor_venda, `${field}.valor_venda`);
      const gross = quantity * price;
      let net = gross;
      if (line.tipo_desconto === 'R$') {
        net -= numeric(line.desconto_valor, `${field}.desconto_valor`);
      } else {
        const discount = numeric(line.desconto_porcentagem ?? line.desconto, `${field}.desconto_porcentagem`);
        if (discount > 100) throw invalid(`${field}.desconto_porcentagem`);
        net = gross * (1 - discount / 100);
      }
      if (net < 0 || !Number.isFinite(net) || !Number.isSafeInteger(cents(net))) throw invalid(field);
      totalCents += cents(net);
      if (!Number.isSafeInteger(totalCents)) throw invalid('valor_total');
    });
  }
  return totalCents / 100;
}
