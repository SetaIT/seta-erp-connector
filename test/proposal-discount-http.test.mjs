import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

test('HTTP creation sends net installments and introduction, with one write and confirmed ERP evidence', async () => {
  let written = null;
  let writes = 0;
  const betel = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      writes++;
      let body = '';
      for await (const chunk of req) body += chunk;
      written = JSON.parse(body);
      if (written.pagamentos[0].pagamento.valor !== '25200.00') {
        res.writeHead(400).end(JSON.stringify({ message: 'Valor das parcelas divergente' }));
        return;
      }
    }
    const proposal = written ? { ...written, id: '123', hash: 'local-test-only' } : null;
    res.end(JSON.stringify({ code: 200, status: 'success', data: req.url.startsWith('/orcamentos/123') ? proposal : (proposal ? [proposal] : []) }));
  });
  betel.listen(0, '127.0.0.1');
  await once(betel, 'listening');
  const allocator = createServer();
  allocator.listen(0, '127.0.0.1');
  await once(allocator, 'listening');
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const connector = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), CONNECTOR_API_KEY: 'local-test-only',
      BETEL_ACCESS_TOKEN: 'local-test-only', BETEL_SECRET_ACCESS_TOKEN: 'local-test-only',
      BETEL_BASE_URL: `http://127.0.0.1:${betel.address().port}`,
      GESTAOCLICK_MCP_READS_ENABLED: 'false', GESTAOCLICK_MCP_WRITES_ENABLED: 'false', ERP_SUPERVISOR_BASE_URL: '',
    },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'local connector starts');
    const response = await fetch(`${base}/erp/orcamentos`, {
      method: 'POST', headers: { authorization: 'Bearer local-test-only', 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: 4686, cliente_id: '52743968', data: '2026-10-08',
        tipo_proposta: 'locacao', solucao: 'Locação de Servidor', meses: 36,
        prazo_entrega_dias: 7, valor_frete_informativo: 2550, valor_frete: 0, sla: '8x5 NBD', forma_pagamento_id: '6321209',
        produtos: [{ produto: { id: '90993663', quantidade: '10', valor_venda: '2800', tipo_desconto: '%', desconto_porcentagem: '10' } }],
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(writes, 1);
    assert.equal(written.pagamentos[0].pagamento.valor, '25200.00');
    assert.equal(written.pagamentos[0].pagamento.data_vencimento, '2026-11-07');
    assert.match(written.introducao, /25\.200,00/);
    assert.equal(written.valor_frete, 0);
    assert.equal(written.produtos[0].produto.desconto_porcentagem, '10');
    assert.equal(result.verification.found, true);
  } finally {
    connector.kill();
    if (connector.exitCode === null) await once(connector, 'exit');
    await new Promise(resolve => betel.close(resolve));
  }
});
