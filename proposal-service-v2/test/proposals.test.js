import test from 'node:test';
import assert from 'node:assert/strict';
import { ProposalService } from '../src/services/proposals.js';

function fakeBetel(responses) {
  return {
    async get(path) {
      const value = responses[path];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`Unexpected path: ${path}`);
      return value;
    }
  };
}

test('rejects non numeric proposal number without calling Betel', async () => {
  const service = new ProposalService({ get: async () => { throw new Error('should not run'); } });
  const result = await service.getByNumber('ABC');
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'validation');
});

test('resolves internal id but exposes commercial proposal data', async () => {
  const service = new ProposalService(fakeBetel({
    '/orcamentos?codigo=4623': { ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } },
    '/orcamentos/392509025': { ok: true, status: 200, data: { data: { id: '392509025', codigo: 4623, nome_cliente: 'Cliente Teste', valor_total: '6450.00' } } }
  }));

  const result = await service.getByNumber('4623');
  assert.equal(result.status, 'success');
  assert.equal(result.codigo, 4623);
  assert.equal(result.nome_cliente, 'Cliente Teste');
  assert.equal(result._internal.id, '392509025');
});

test('refuses identity mismatch', async () => {
  const service = new ProposalService(fakeBetel({
    '/orcamentos?codigo=4623': { ok: true, status: 200, data: { data: [{ id: '10', codigo: 4623 }] } },
    '/orcamentos/10': { ok: true, status: 200, data: { data: { id: '10', codigo: 9999 } } }
  }));

  const result = await service.getByNumber('4623');
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'identity_mismatch');
});
