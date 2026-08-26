import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EFFECTIVE_STATUS, reconcileWrite } from '../commercial-write-reconciliation.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function observedFetch(url, init) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(`Downstream HTTP ${response.status}`), {
      status: response.status,
      data,
      endpoint: new URL(url).pathname,
      request_id: response.headers.get('x-request-id'),
    });
  }
  return { http_status: response.status, data, request_id: response.headers.get('x-request-id') };
}

test('simulated Betel HTTP 400 preserves body and recovers through read-after-write', async () => {
  let proposal = null;
  let writes = 0;
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', 'betel-simulated-400');
    if (req.method === 'POST') {
      writes += 1;
      proposal = { id: 88, codigo: 4632, cliente_id: '4977593' };
      res.writeHead(400).end(JSON.stringify({ error: 'validation_after_commit', detail: { codigo: 4632 } }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({ data: proposal ? [proposal] : [] }));
  }, async (baseUrl) => {
    const result = await reconcileWrite({
      operation: 'create_proposal',
      endpoint: '/orcamentos',
      correlationId: 'integration-betel-4632',
      payload: { codigo: 4632, cliente_id: '4977593' },
      write: () => observedFetch(`${baseUrl}/orcamentos`, { method: 'POST' }),
      verify: async () => {
        const response = await fetch(`${baseUrl}/orcamentos?codigo=4632`);
        const body = await response.json();
        return body.data.length
          ? { outcome: 'found', equivalent: true, resource: body.data[0] }
          : { outcome: 'absent' };
      },
    });
    assert.equal(writes, 1);
    assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS_RECOVERED);
    assert.deepEqual(result.downstream_response, { error: 'validation_after_commit', detail: { codigo: 4632 } });
    assert.equal(result.downstream_request_id, 'betel-simulated-400');
  });
});

test('simulated HubSpot direct success is primary evidence during indexing delay', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/deals') {
      res.writeHead(201).end(JSON.stringify({ id: 'deal-4632', properties: { numero_da_proposta: '4632' } }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({ total: 0, results: [] }));
  }, async (baseUrl) => {
    const result = await reconcileWrite({
      operation: 'create_hubspot_deal',
      endpoint: '/deals',
      correlationId: 'integration-hubspot-4632',
      payload: { numero_da_proposta: '4632' },
      acceptDirectEvidence: true,
      directEvidence: (value) => Boolean(value?.id),
      write: () => observedFetch(`${baseUrl}/deals`, { method: 'POST' }),
      verify: async () => ({ outcome: 'absent', details: { total: 0 } }),
    });
    assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS);
    assert.equal(result.downstream_response.id, 'deal-4632');
  });
});
