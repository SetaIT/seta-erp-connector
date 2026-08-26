import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

process.env.BETEL_ACCESS_TOKEN = 'mock-access';
process.env.BETEL_SECRET_ACCESS_TOKEN = 'mock-secret';
process.env.RENTAL_BILLING_API_KEY = 'mock-api-key';

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  if (String(url).includes('/recebimentos') && (options.method || 'GET') === 'POST') return new Response(JSON.stringify({ data: { id: 'R-1' } }), { status: 200 });
  if (String(url).includes('/notas_fiscais_servicos/emitir/')) return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  if (String(url).endsWith('/notas_fiscais_servicos') && (options.method || 'GET') === 'POST') return new Response(JSON.stringify({ data: { dados: 'N-1' } }), { status: 200 });
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
};

const { app } = await import('../rental-billing-service.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;

function request(path, body, authorized = true) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { ...(authorized ? { Authorization: 'Bearer mock-api-key' } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const payload = {
  idempotency_key: 'cliente-2026-08',
  recebimento: { descricao: 'Locacao agosto', data_vencimento: '2026-08-30', plano_contas_id: 1, forma_pagamento_id: 2, conta_bancaria_id: 3, valor: 1500, data_competencia: '2026-08-01', cliente_id: 10 },
  nfse: { destinatario_id_cliente: 10, valor_servico: 1500, codigo_atividade: '1.05', codigo_natureza_operacao: '1', iss_retido: 0, cidade_incidencia_issqn: 'Sao Paulo', estado_incidencia_issqn: 'SP', descricao: 'Locacao agosto' }
};

try {
  const schema = JSON.parse(fs.readFileSync(new URL('../openapi-rental-billing.json', import.meta.url), 'utf8'));
  assert.equal(schema.openapi, '3.1.0');
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/erp/locacoes/faturamento/preflight', payload, false)).status, 401);

  calls.length = 0;
  const preview = await request('/erp/locacoes/faturamento/preflight', payload);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.write_attempted, false);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);

  calls.length = 0;
  const blocked = await request('/erp/locacoes/faturamento/executar', payload);
  assert.equal(blocked.status, 400);
  assert.equal(calls.length, 0);

  calls.length = 0;
  const created = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true });
  assert.equal(created.status, 201);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname), ['/api/recebimentos', '/api/notas_fiscais_servicos']);
  const nfseCreate = calls.find(call => call.method === 'POST' && new URL(call.url).pathname === '/api/notas_fiscais_servicos');
  assert.equal(nfseCreate.body.envio_automatico, 0);

  calls.length = 0;
  const emissionBlocked = await request('/erp/locacoes/faturamento/executar', { ...payload, confirmacao_gravacao: true, emitir_nfse: true });
  assert.equal(emissionBlocked.status, 400);
  assert.equal(calls.length, 0);

  console.log('QA APROVADO: servico isolado, preflight read-only, gravacao confirmada e emissao protegida.');
} finally {
  server.close();
}
