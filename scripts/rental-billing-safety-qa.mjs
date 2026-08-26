import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

// Safety characterization only. Every upstream call is intercepted by this
// in-memory mock; this script must never receive real Betel credentials.
process.env.BETEL_ACCESS_TOKEN = 'qa-mock-access';
process.env.BETEL_SECRET_ACCESS_TOKEN = 'qa-mock-secret';
process.env.RENTAL_BILLING_API_KEY = 'qa-mock-api-key';
process.env.RENTAL_BILLING_WRITES_ENABLED = 'false';
process.env.RENTAL_BILLING_KILL_SWITCH = 'true';
process.env.RENTAL_BILLING_EMISSION_ENABLED = 'true';
process.env.RENTAL_BILLING_LEDGER_PATH = `/tmp/seta-rental-billing-safety-${process.pid}.json`;

let responder = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const call = {
    url: String(url),
    method: options.method || 'GET',
    body: options.body ? JSON.parse(options.body) : null
  };
  calls.push(call);
  return responder(call);
};

const { app } = await import('../rental-billing-service.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;

const payload = {
  contrato_id: 'contract-10',
  idempotency_key: 'contract-10:2026-08',
  recebimento: {
    descricao: 'Locacao agosto', data_vencimento: '2026-08-30',
    plano_contas_id: 1, forma_pagamento_id: 2, conta_bancaria_id: 3,
    valor: 1500, data_competencia: '2026-08-01', cliente_id: 10
  },
  nfse: {
    destinatario_id_cliente: 10, valor_servico: 1500,
    codigo_atividade: '1.05', codigo_natureza_operacao: '1', iss_retido: 0,
    cidade_incidencia_issqn: 'Sao Paulo', estado_incidencia_issqn: 'SP',
    descricao: 'Locacao agosto'
  }
};

function request(path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer qa-mock-api-key',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const findings = [];
async function check(id, title, test) {
  calls.length = 0;
  fs.rmSync(process.env.RENTAL_BILLING_LEDGER_PATH, { force: true });
  fs.rmSync(`${process.env.RENTAL_BILLING_LEDGER_PATH}.lock`, { force: true });
  try {
    await test();
    console.log(`PASS ${id}: ${title}`);
  } catch (error) {
    findings.push({ id, title, evidence: error.message });
    console.error(`BLOCKED ${id}: ${title} — ${error.message}`);
  }
}

try {
  await check('SAFE-01', 'feature flag e kill switch bloqueiam escrita', async () => {
    responder = async call => {
      if (call.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: 'unexpected-write' } }), { status: 200 });
    };
    const result = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    assert.notEqual(result.status, 201, 'servico gravou mesmo com writes=false e kill-switch=true');
    assert.equal(calls.filter(call => call.method !== 'GET').length, 0, 'houve chamada POST upstream');
  });

  process.env.RENTAL_BILLING_WRITES_ENABLED = 'true';
  process.env.RENTAL_BILLING_KILL_SWITCH = 'false';

  await check('SAFE-02', 'idempotencia resiste a duas execucoes concorrentes', async () => {
    let preflightGets = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    responder = async call => {
      if (call.method === 'GET') {
        preflightGets += 1;
        if (preflightGets === 4) release();
        await gate;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const isInvoice = call.url.endsWith('/notas_fiscais_servicos');
      return new Response(JSON.stringify({ data: isInvoice ? { dados: `N-${calls.length}` } : { id: `R-${calls.length}` } }), { status: 200 });
    };
    const results = await Promise.all([
      request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true }),
      request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true })
    ]);
    assert.equal(results.filter(result => result.status === 201).length, 1, 'mais de uma execucao concorrente foi aceita');
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/recebimentos')).length, 1, 'recebimento duplicado');
  });

  await check('SAFE-03', 'preflight percorre paginacao completa de NFS-e', async () => {
    responder = async call => {
      if (call.url.includes('/recebimentos')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const marker = '[SETA-LOCACAO:contract-10:2026-08]';
      if (call.url.includes('pagina=2')) return new Response(JSON.stringify({ meta: { total_paginas: 2 }, data: [{ id: 'N-old', descricao: marker }] }), { status: 200 });
      return new Response(JSON.stringify({ meta: { total_paginas: 2, pagina_atual: 1 }, data: [] }), { status: 200 });
    };
    const result = await request('/erp/locacoes/faturamento/preflight', payload);
    assert.equal(result.body.can_write, false, 'duplicata existente na pagina 2 nao foi detectada');
    assert.ok(calls.some(call => call.url.includes('pagina=2')), 'pagina 2 nao foi consultada');
  });

  await check('SAFE-04', 'resposta perdida nao autoriza repeticao de recebimento', async () => {
    let receiptWrites = 0;
    responder = async call => {
      if (call.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (call.url.endsWith('/recebimentos')) {
        receiptWrites += 1;
        throw new TypeError('mock: connection lost after upstream commit');
      }
      return new Response(JSON.stringify({ data: { dados: 'N-1' } }), { status: 200 });
    };
    await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    assert.equal(receiptWrites, 1, 'retry repetiu POST de recebimento em estado de resultado desconhecido');
  });

  await check('SAFE-05', 'falha parcial permite retomada somente da NFS-e', async () => {
    let phase = 1;
    let invoiceWrites = 0;
    const marker = '[SETA-LOCACAO:contract-10:2026-08]';
    responder = async call => {
      if (call.method === 'GET') {
        if (call.url.includes('/recebimentos') && phase === 2) return new Response(JSON.stringify({ data: [{ id: 'R-1', descricao: marker }] }), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (call.url.endsWith('/recebimentos')) return new Response(JSON.stringify({ data: { id: 'R-1' } }), { status: 200 });
      if (call.url.endsWith('/notas_fiscais_servicos')) {
        invoiceWrites += 1;
        if (phase === 1) return new Response(JSON.stringify({ error: 'mock failure' }), { status: 500 });
        return new Response(JSON.stringify({ data: { dados: 'N-1' } }), { status: 200 });
      }
      throw new Error('unexpected mock call');
    };
    const first = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    assert.equal(first.body.status, 'partial_failure');
    phase = 2;
    const resumed = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    assert.equal(resumed.status, 200, 'fluxo nao retomou a partir da NFS-e ausente');
    assert.equal(resumed.body.resumed, true, 'retomada nao foi identificada no retorno');
    assert.equal(invoiceWrites, 2, 'NFS-e nao foi tentada na retomada');
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/recebimentos')).length, 1, 'retomada duplicou recebimento');
  });

  await check('SAFE-06', 'emissao repetida e bloqueada por estado/idempotencia', async () => {
    let emissionWrites = 0;
    responder = async call => {
      if (call.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (call.url.includes('/emitir/')) {
        emissionWrites += 1;
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      if (call.url.endsWith('/recebimentos')) return new Response(JSON.stringify({ data: { id: 'R-emit' } }), { status: 200 });
      return new Response(JSON.stringify({ data: { dados: 'N-emit' } }), { status: 200 });
    };
    const body = { ...payload, confirmacao_gravacao: true, emitir_nfse: true, confirmacao_emissao: true };
    const first = await request('/erp/locacoes/faturamento/executar', body);
    const second = await request('/erp/locacoes/faturamento/executar', body);
    assert.ok([200, 201].includes(first.status), 'primeira emissao controlada falhou');
    assert.equal(second.status, 409, 'segunda emissao foi aceita sem consultar situacao');
    assert.equal(emissionWrites, 1, 'comando de emissao foi repetido');
  });

  await check('SAFE-07', 'HTTP 2xx com payload de erro nao e tratado como sucesso', async () => {
    responder = async call => {
      if (call.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ code: 200, status: 'error', data: { ok: false, mensagem: 'rejeitado' } }), { status: 200 });
    };
    const result = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
    assert.notEqual(result.status, 201, 'payload Betel status=error foi classificado como sucesso');
  });

  await check('SAFE-08', 'valores de recebimento e NFS-e devem ser iguais', async () => {
    responder = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const mismatch = structuredClone(payload);
    mismatch.nfse.valor_servico = 1499.99;
    const result = await request('/erp/locacoes/faturamento/preflight', mismatch);
    assert.equal(result.status, 400, 'preflight aceitou valores divergentes');
  });

  await check('SAFE-09', 'normalizacao monetaria nao multiplica decimal com ponto', async () => {
    responder = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const decimal = structuredClone(payload);
    decimal.recebimento.valor = 1500.5;
    decimal.nfse.valor_servico = '1500.50';
    const result = await request('/erp/locacoes/faturamento/preflight', decimal);
    assert.equal(result.status, 200, 'valores decimais equivalentes foram rejeitados');
    assert.equal(result.body.can_write, true, 'valor decimal foi corrompido durante validacao');
  });

  await check('SAFE-10', 'chamadas upstream possuem timeout explicito', async () => {
    const source = fs.readFileSync(new URL('../rental-billing-service.js', import.meta.url), 'utf8');
    assert.match(source, /AbortSignal\.timeout|AbortController/, 'fetch pode aguardar indefinidamente; nenhum timeout foi configurado');
  });

  console.log(JSON.stringify({ suite: 'rental-billing-safety', blockers: findings }, null, 2));
  if (findings.length) process.exitCode = 2;
} finally {
  server.close();
  fs.rmSync(process.env.RENTAL_BILLING_LEDGER_PATH, { force: true });
  fs.rmSync(`${process.env.RENTAL_BILLING_LEDGER_PATH}.lock`, { force: true });
}
