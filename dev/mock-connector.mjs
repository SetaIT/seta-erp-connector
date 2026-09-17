import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8080);
const CONNECTOR_API_KEY = String(process.env.CONNECTOR_API_KEY || 'dev-only');

const paymentMethods = [
  {
    id: '6321209',
    forma_pagamento_id: '6321209',
    nome: 'Boleto Bancário - Conta Integrada',
    nome_forma_pagamento: 'Boleto Bancário - Conta Integrada',
    maximo_parcelas: '120',
    intervalo_parcelas: '30',
    intervalo_primeira_parcela: '0',
  },
  {
    id: '6321210',
    forma_pagamento_id: '6321210',
    nome: 'PIX',
    nome_forma_pagamento: 'PIX',
    maximo_parcelas: '1',
    intervalo_parcelas: '0',
    intervalo_primeira_parcela: '0',
  },
];

const situations = [
  { id: '1406905', situacao_id: '1406905', nome: 'Em aberto', padrao: '1' },
  { id: '1406906', situacao_id: '1406906', nome: 'Em andamento' },
  { id: '1406907', situacao_id: '1406907', nome: 'Concretizado' },
  { id: '1406908', situacao_id: '1406908', nome: 'Cancelado' },
  { id: '1406909', situacao_id: '1406909', nome: 'Enviado Parcialmente' },
];

const clients = [
  {
    id: '990001',
    cliente_id: '990001',
    nome: 'CLIENTE DE VALIDAÇÃO S/A',
    razao_social: 'CLIENTE DE VALIDAÇÃO S/A',
    cnpj: '00000000000191',
    email: 'validacao@example.invalid',
    celular: '+5511999999999',
  },
];

const catalogProducts = [
  {
    id: '880001',
    produto_id: '880001',
    codigo_interno: 'SW-VALIDACAO-48P',
    nome: 'Switch de validação 48 portas',
    nome_produto: 'Switch de validação 48 portas',
    estoque: '10',
    valor_venda: '36327.00',
    sigla_unidade: 'UN',
    tipo_valor_id: '134894',
    nome_tipo_valor: 'Varejo',
  },
];

const catalogServices = [
  {
    id: '770001',
    servico_id: '770001',
    codigo: 'SERV-VALIDACAO',
    nome: 'Serviço técnico de validação',
    descricao: 'Serviço técnico de validação',
    valor_venda: '700.00',
  },
];

let proposal = {
  id: '9001001',
  orcamento_id: '9001001',
  codigo: '9001',
  cliente_id: '990001',
  nome_cliente: 'CLIENTE DE VALIDAÇÃO S/A',
  data: '2026-09-16',
  previsao_entrega: '2026-10-01',
  situacao_id: '1406906',
  nome_situacao: 'Em andamento',
  valor_total: '36327.00',
  valor_produtos: '36327.00',
  valor_servicos: '0.00',
  valor_frete: '0.00',
  desconto_valor: '0.00',
  desconto_porcentagem: '0.00',
  condicao_pagamento: 'a_vista',
  forma_pagamento_id: '6321209',
  nome_forma_pagamento: 'Boleto Bancário - Conta Integrada',
  data_primeira_parcela: '2026-10-21',
  numero_parcelas: '1',
  intervalo_dias: '0',
  introducao: 'Prazo estimado de entrega: 15 dias | Frete: R$ 0,00\nSolução: Locação de Switch\n\nProposta de Locação – 36 Meses\n\nValor mensal: R$ 36.327,00\nSLA: 8x5 NBD',
  observacoes: 'CONFIDENCIALIDADE E CONDIÇÕES GERAIS',
  hash: 'VALIDA9001',
  produtos: [
    {
      produto: {
        produto_id: '880001',
        id: '880001',
        variacao_id: '',
        codigo_interno: 'SW-VALIDACAO-48P',
        nome_produto: 'Switch de validação 48 portas',
        detalhes: 'Fixture isolada; não corresponde a cliente real.',
        sigla_unidade: 'UN',
        quantidade: '1.00',
        tipo_valor_id: '134894',
        nome_tipo_valor: 'Varejo',
        valor_venda: '36327.00',
        tipo_desconto: '%',
        desconto_valor: '0.00',
        desconto_porcentagem: '0.00',
        valor_total: '36327.00',
      },
    },
  ],
  servicos: [],
  pagamentos: [
    {
      pagamento: {
        data_vencimento: '2026-10-21',
        valor: '36327.00',
        forma_pagamento_id: '6321209',
        nome_forma_pagamento: 'Boleto Bancário - Conta Integrada',
        observacao: '',
      },
    },
  ],
};

const deal = {
  id: 'mock-deal-9001',
  archived: false,
  properties: {
    dealname: 'Proposta 9001 — validação isolada',
    numero_da_proposta: '9001',
    amount: '1307772.00',
    solucao: 'Locação de Switch',
    pipeline: '9501279',
    dealstage: '9501283',
  },
};

function auth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

function lineTotal(entry, wrapper) {
  const line = entry?.[wrapper] && typeof entry[wrapper] === 'object' ? entry[wrapper] : entry || {};
  if (line.valor_total != null && String(line.valor_total).trim() !== '') return cents(line.valor_total);
  const quantity = Number(line.quantidade || 0);
  const unit = Number(line.valor_venda || line.valor || 0);
  const percent = Number(line.desconto_porcentagem || 0);
  const fixed = Number(line.desconto_valor || 0);
  return Math.round((quantity * unit * (1 - percent / 100) - fixed) * 100);
}

function calculateOrderTotal(body) {
  const products = Array.isArray(body.produtos) ? body.produtos : proposal.produtos;
  const services = Array.isArray(body.servicos) ? body.servicos : proposal.servicos;
  const productTotal = products.reduce((sum, item) => sum + lineTotal(item, 'produto'), 0);
  const serviceTotal = services.reduce((sum, item) => sum + lineTotal(item, 'servico'), 0);
  const freight = cents(body.valor_frete ?? proposal.valor_frete);
  const discount = cents(body.desconto_valor ?? proposal.desconto_valor);
  return Math.max(0, productTotal + serviceTotal + freight - discount);
}

function normalizePayments(rows = []) {
  return rows.map((row) => {
    const payment = row?.pagamento && typeof row.pagamento === 'object' ? row.pagamento : row;
    return {
      pagamento: {
        data_vencimento: String(payment.data_vencimento || ''),
        valor: (Number(payment.valor || 0)).toFixed(2),
        forma_pagamento_id: String(payment.forma_pagamento_id || ''),
        nome_forma_pagamento: paymentMethods.find((item) => item.id === String(payment.forma_pagamento_id || ''))?.nome || '',
        observacao: String(payment.observacao || ''),
      },
    };
  });
}

function proposalSummary() {
  return {
    id: proposal.id,
    codigo: proposal.codigo,
    cliente_id: proposal.cliente_id,
    nome_cliente: proposal.nome_cliente,
    data: proposal.data,
    situacao_id: proposal.situacao_id,
    nome_situacao: proposal.nome_situacao,
    valor_total: proposal.valor_total,
    hash: proposal.hash,
  };
}

function listResponse(data) {
  return {
    code: 200,
    status: 'success',
    meta: {
      total_registros: data.length,
      total_paginas: 1,
      total_registros_pagina: data.length,
      pagina_atual: 1,
      limite_por_pagina: 20,
    },
    data,
    fixture: true,
  };
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'seta-erp-mock-v1-dev',
    fixture: true,
    external_writes: false,
    proposal_number: proposal.codigo,
  });
});

app.use(auth);

app.get('/erp/formas-pagamentos', (_req, res) => res.json(listResponse(paymentMethods)));
app.get(['/erp/situacoes-orcamentos', '/erp/situacoes_orcamentos'], (_req, res) => res.json(listResponse(situations)));
app.get('/erp/clientes', (req, res) => {
  const q = String(req.query.nome || req.query.cpf_cnpj || '').toLowerCase();
  const rows = q ? clients.filter((item) => JSON.stringify(item).toLowerCase().includes(q.replace(/\D/g, '') || q)) : clients;
  res.json(listResponse(rows));
});
app.get('/erp/produtos', (req, res) => {
  const q = String(req.query.nome || req.query.codigo_interno || '').toLowerCase();
  const rows = q ? catalogProducts.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : catalogProducts;
  res.json(listResponse(rows));
});
app.get('/erp/servicos', (req, res) => {
  const q = String(req.query.nome || '').toLowerCase();
  const rows = q ? catalogServices.filter((item) => JSON.stringify(item).toLowerCase().includes(q)) : catalogServices;
  res.json(listResponse(rows));
});

app.get('/erp/orcamentos', (req, res) => {
  const code = String(req.query.codigo || '');
  const clientId = String(req.query.cliente_id || '');
  const found = (!code || code === proposal.codigo) && (!clientId || clientId === proposal.cliente_id);
  res.json(listResponse(found ? [proposalSummary()] : []));
});
app.get('/erp/orcamentos/numero/:numero', (req, res) => {
  if (req.params.numero !== proposal.codigo) return res.status(404).json({ status: 'error', message: 'Fixture não encontrada.' });
  res.json({ status: 'success', ...proposal, fixture: true });
});
app.get('/erp/propostas/:numero/contexto', (req, res) => {
  if (req.params.numero !== proposal.codigo) return res.status(404).json({ status: 'error', message: 'Fixture não encontrada.' });
  res.json({ status: 'success', numero_proposta: proposal.codigo, erp: { proposal, public_link: `https://app.setatelecom.com.br/prop/${proposal.hash}` }, fixture: true });
});
app.get('/erp/orcamentos/:id', (req, res) => {
  if (req.params.id !== proposal.id) return res.status(404).json({ status: 'error', message: 'Fixture não encontrada.' });
  res.json({ status: 'success', ...proposal, fixture: true });
});

app.put('/erp/orcamentos/:id', (req, res) => {
  if (req.params.id !== proposal.id) return res.status(404).json({ status: 'error', message: 'Fixture não encontrada.' });
  const body = req.body || {};
  const orderTotal = calculateOrderTotal(body);
  if (Array.isArray(body.pagamentos) && body.pagamentos.length > 0) {
    const paymentTotal = body.pagamentos.reduce((sum, row) => {
      const payment = row?.pagamento && typeof row.pagamento === 'object' ? row.pagamento : row;
      return sum + cents(payment.valor);
    }, 0);
    if (paymentTotal !== orderTotal) {
      return res.status(422).json({
        status: 'error',
        effective_status: 'FAILED',
        mensagem: `O valor do pedido não pode ser diferente do valor das parcelas, está passando ${(paymentTotal / 100).toFixed(2)} no valor das parcelas.`,
        expected_order_total: (orderTotal / 100).toFixed(2),
        received_payment_total: (paymentTotal / 100).toFixed(2),
        fixture: true,
      });
    }
  }

  const next = { ...proposal, ...body };
  next.id = proposal.id;
  next.orcamento_id = proposal.id;
  next.codigo = proposal.codigo;
  next.valor_total = (orderTotal / 100).toFixed(2);
  next.valor_produtos = (Array.isArray(body.produtos) ? body.produtos.reduce((sum, item) => sum + lineTotal(item, 'produto'), 0) : cents(proposal.valor_produtos)) / 100;
  next.valor_produtos = Number(next.valor_produtos).toFixed(2);
  next.valor_servicos = (Array.isArray(body.servicos) ? body.servicos.reduce((sum, item) => sum + lineTotal(item, 'servico'), 0) : cents(proposal.valor_servicos)) / 100;
  next.valor_servicos = Number(next.valor_servicos).toFixed(2);
  if (Array.isArray(body.pagamentos)) next.pagamentos = normalizePayments(body.pagamentos);
  if (Array.isArray(body.produtos)) next.produtos = body.produtos;
  if (Array.isArray(body.servicos)) next.servicos = body.servicos;
  if (body.situacao_id) {
    next.nome_situacao = situations.find((item) => item.id === String(body.situacao_id))?.nome || proposal.nome_situacao;
  }
  proposal = next;

  res.json({
    status: 'success',
    action: 'proposal_updated',
    effective_status: 'SUCCESS',
    found: true,
    id: proposal.id,
    codigo: proposal.codigo,
    proposal_number: proposal.codigo,
    verification: { confirmed: true, equivalent: true },
    data: proposal,
    fixture: true,
  });
});

app.post('/erp/orcamentos/numero/:numero/clonar', (req, res) => {
  const newCode = String(req.body?.novo_codigo || '9002');
  res.json({
    status: 'success',
    effective_status: 'SUCCESS',
    found: true,
    id: `${proposal.id}-clone`,
    codigo: newCode,
    hash: `VALIDA${newCode}`,
    fixture: true,
  });
});

app.post('/erp/orcamentos', (req, res) => {
  const code = String(req.body?.codigo || '9002');
  res.json({
    status: 'success',
    effective_status: 'SUCCESS',
    found: true,
    id: `mock-${code}`,
    codigo: code,
    hash: `VALIDA${code}`,
    verification: { confirmed: true },
    fixture: true,
  });
});

app.get('/erp/hubspot/negocios', (req, res) => {
  const number = String(req.query.numero_proposta || '');
  res.json({ status: 'success', total: number === proposal.codigo ? 1 : 0, results: number === proposal.codigo ? [deal] : [], fixture: true });
});
app.get('/erp/hubspot/negocios/:id/fases', (req, res) => {
  res.json({
    status: 'success',
    current_stage_id: deal.properties.dealstage,
    pipeline: { id: deal.properties.pipeline, label: 'Locação' },
    stages: [
      { id: '9501282', label: 'Aguardando Proposta', is_closed: false },
      { id: '9501283', label: 'Proposta Enviada', is_closed: false },
      { id: '14236287', label: 'Negociação', is_closed: false },
    ],
    fixture: true,
  });
});
app.get('/erp/hubspot/empresas', (_req, res) => res.json({ results: [{ id: 'mock-company-1', properties: { name: 'CLIENTE DE VALIDAÇÃO S/A', domain: 'example.invalid' } }], fixture: true }));
app.get('/erp/hubspot/empresas/:id/contatos', (_req, res) => res.json({ results: [{ id: 'mock-contact-1', properties: { firstname: 'Contato', lastname: 'Validação', email: 'validacao@example.invalid', phone: '+5511999999999' } }], fixture: true }));
app.get('/erp/hubspot/contatos/pesquisar', (_req, res) => res.json({ results: [{ id: 'mock-contact-1', properties: { firstname: 'Contato', lastname: 'Validação', email: 'validacao@example.invalid', phone: '+5511999999999' } }], fixture: true }));

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Rota de fixture não implementada: ${req.method} ${req.path}`, fixture: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'mock_connector_started', port: PORT, fixture: true, external_writes: false }));
});
