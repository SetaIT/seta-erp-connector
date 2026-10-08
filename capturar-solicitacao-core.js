function clean(value) {
  return String(value ?? '').trim();
}

function digits(value) {
  return clean(value).replace(/\D/g, '');
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  const number = digits(value);
  if (!number) return '';
  if (number.length === 10 || number.length === 11) return `55${number}`;
  return number;
}

function normalizeCnpj(value) {
  const number = digits(value);
  return number.length === 14 ? number : '';
}

function normalizeMode(value) {
  const text = clean(value).toLowerCase();
  if (!text) return '';
  if (/loca|alug|mensal|36 meses|24 meses|12 meses/.test(text)) return 'locacao';
  if (/compr|venda|aquisi/.test(text)) return 'venda';
  if (/cot|orc|orç|proposta/.test(text)) return 'orcamento';
  return '';
}

function normalizeItem(item = {}) {
  return {
    descricao: clean(item.descricao || item.description || item.produto || item.product),
    quantidade: Number.isFinite(Number(item.quantidade ?? item.quantity)) ? Number(item.quantidade ?? item.quantity) : null,
    fabricante: clean(item.fabricante || item.brand || item.marca),
    modelo: clean(item.modelo || item.model),
    especificacoes: Array.isArray(item.especificacoes)
      ? item.especificacoes.map(clean).filter(Boolean)
      : clean(item.especificacoes || item.specs)
          .split(/[;,\n]/)
          .map(clean)
          .filter(Boolean)
  };
}

function confidenceFor(value, weight = 1) {
  if (Array.isArray(value)) return value.length ? weight : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? weight : 0;
  return clean(value) ? weight : 0;
}

export function normalizeCommercialIntake(input = {}) {
  const company = input.empresa || input.company || {};
  const contact = input.contato || input.contact || {};
  const items = Array.isArray(input.itens || input.items) ? (input.itens || input.items).map(normalizeItem) : [];
  const modalidade = normalizeMode(input.modalidade || input.mode || input.tipo || input.type || input.contexto || input.context);

  const normalized = {
    origem: clean(input.origem || input.source || 'manual'),
    empresa: {
      nome: clean(company.nome || company.name || input.empresa_nome || input.company_name),
      cnpj: normalizeCnpj(company.cnpj || input.cnpj),
      dominio: clean(company.dominio || company.domain || input.dominio || input.domain).toLowerCase()
    },
    contato: {
      nome: clean(contact.nome || contact.name || input.contato_nome || input.contact_name),
      email: normalizeEmail(contact.email || input.email),
      telefone: normalizePhone(contact.telefone || contact.phone || contact.whatsapp || input.telefone || input.phone || input.whatsapp)
    },
    modalidade,
    prazo_meses: Number.isFinite(Number(input.prazo_meses || input.term_months)) ? Number(input.prazo_meses || input.term_months) : null,
    local_entrega: clean(input.local_entrega || input.delivery_location),
    observacoes: clean(input.observacoes || input.notes),
    itens: items
  };

  const missing = [];
  if (!normalized.empresa.cnpj && !normalized.empresa.nome && !normalized.empresa.dominio) missing.push('empresa');
  if (!normalized.contato.email && !normalized.contato.telefone && !normalized.contato.nome) missing.push('contato');
  if (!normalized.modalidade) missing.push('modalidade');
  if (!normalized.itens.length) missing.push('itens');
  normalized.itens.forEach((item, index) => {
    if (!item.descricao && !item.modelo) missing.push(`itens[${index}].descricao`);
    if (!item.quantidade || item.quantidade <= 0) missing.push(`itens[${index}].quantidade`);
  });

  const score = [
    confidenceFor(normalized.empresa.cnpj || normalized.empresa.nome || normalized.empresa.dominio, 25),
    confidenceFor(normalized.contato.email || normalized.contato.telefone || normalized.contato.nome, 15),
    confidenceFor(normalized.modalidade, 20),
    confidenceFor(normalized.itens, 25),
    confidenceFor(normalized.observacoes || normalized.local_entrega || normalized.prazo_meses, 15)
  ].reduce((sum, value) => sum + value, 0);

  return {
    ...normalized,
    confianca: score,
    requer_revisao: missing.length > 0 || score < 85,
    campos_pendentes: [...new Set(missing)]
  };
}

export function buildIntakeLookupPlan(intake) {
  const normalized = normalizeCommercialIntake(intake);
  const steps = [];
  if (normalized.empresa.cnpj) steps.push({ tipo: 'cnpj', valor: normalized.empresa.cnpj, prioridade: 1 });
  if (normalized.empresa.dominio) steps.push({ tipo: 'dominio', valor: normalized.empresa.dominio, prioridade: 2 });
  if (normalized.empresa.nome) steps.push({ tipo: 'nome', valor: normalized.empresa.nome, prioridade: 3 });
  if (normalized.contato.telefone) steps.push({ tipo: 'telefone', valor: normalized.contato.telefone, prioridade: 4 });
  return steps;
}
