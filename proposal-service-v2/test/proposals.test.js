import test from 'node:test';
import assert from 'node:assert/strict';
import { ProposalService } from '../src/services/proposals.js';

function fakeBetel(sequence) {
  const calls = [];
  function take(method, path) {
    calls.push({ method, path });
    const key = `${method} ${path}`;
    const queue = sequence[key];
    if (!queue || queue.length === 0) throw new Error(`Unexpected call: ${key}`);
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  }
  return {
    calls,
    get: path => take('GET', path),
    put: (path, body) => { calls.push({ method: 'PUT_BODY', path, body }); return take('PUT', path); },
    delete: path => take('DELETE', path)
  };
}

const proposal = {
  id: '392509025', codigo: 4623, cliente_id: '61031736', nome_cliente: 'Cliente Teste',
  situacao_id: '1406913', data: '2026-08-20', validade: '10', previsao_entrega: '2026-08-30',
  valor_total: '6450.00', valor_frete: 1500, produtos: [{ produto: { id: '1' } }]
};

function readSequence(detail = proposal) {
  return {
    'GET /orcamentos?codigo=4623': [{ ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } }],
    'GET /orcamentos/392509025': [{ ok: true, status: 200, data: { data: detail } }]
  };
}

test('rejects non numeric proposal number without calling Betel', async () => {
  const service = new ProposalService({ get: async () => { throw new Error('should not run'); } });
  const result = await service.getByNumber('ABC');
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'validation');
});

test('resolves internal id but exposes commercial proposal data', async () => {
  const betel = fakeBetel(readSequence());
  const service = new ProposalService(betel);
  const result = await service.getByNumber('4623');
  assert.equal(result.status, 'success');
  assert.equal(result.codigo, 4623);
  assert.equal(result.nome_cliente, 'Cliente Teste');
  assert.equal(result._internal.id, '392509025');
});

test('refuses identity mismatch', async () => {
  const betel = fakeBetel({
    'GET /orcamentos?codigo=4623': [{ ok: true, status: 200, data: { data: [{ id: '10', codigo: 4623 }] } }],
    'GET /orcamentos/10': [{ ok: true, status: 200, data: { data: { id: '10', codigo: 9999 } } }]
  });
  const result = await new ProposalService(betel).getByNumber('4623');
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'identity_mismatch');
});

test('edit requires explicit confirmation before any write or lookup', async () => {
  const betel = fakeBetel({});
  const result = await new ProposalService(betel).editByNumber('4623', { validade: '15' });
  assert.equal(result.stage, 'confirmation');
  assert.equal(result.write_attempted, false);
  assert.equal(betel.calls.length, 0);
});

test('edit resolves by number, writes by internal id, then verifies', async () => {
  const after = { ...proposal, validade: '15' };
  const betel = fakeBetel({
    'GET /orcamentos?codigo=4623': [
      { ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } },
      { ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } }
    ],
    'GET /orcamentos/392509025': [
      { ok: true, status: 200, data: { data: proposal } },
      { ok: true, status: 200, data: { data: after } }
    ],
    'PUT /orcamentos/392509025': [{ ok: true, status: 200, data: { data: after } }]
  });
  const result = await new ProposalService(betel).editByNumber('4623', { validade: '15' }, { confirmed: true });
  assert.equal(result.status, 'success');
  assert.equal(result.write_succeeded, true);
  assert.equal(result.requested_changes_matched, true);
  const putBody = betel.calls.find(call => call.method === 'PUT_BODY')?.body;
  assert.equal(putBody.codigo, 4623);
  assert.equal(putBody.cliente_id, '61031736');
  assert.equal(putBody.validade, '15');
  assert.deepEqual(putBody.produtos, proposal.produtos);
});

test('edit rejects unknown fields before writing', async () => {
  const betel = fakeBetel({});
  const result = await new ProposalService(betel).editByNumber('4623', { id: 'hack' }, { confirmed: true });
  assert.equal(result.stage, 'validation');
  assert.deepEqual(result.invalid_fields, ['id']);
  assert.equal(betel.calls.length, 0);
});

test('delete requires explicit confirmation and exact number code', async () => {
  const betel = fakeBetel({});
  const service = new ProposalService(betel);
  const noConfirm = await service.deleteByNumber('4623');
  assert.equal(noConfirm.stage, 'confirmation');
  const mismatch = await service.deleteByNumber('4623', { confirmed: true, confirmationCode: '4624' });
  assert.equal(mismatch.stage, 'confirmation_mismatch');
  assert.equal(betel.calls.length, 0);
});

test('delete resolves by number, deletes once, and verifies absence', async () => {
  const betel = fakeBetel({
    'GET /orcamentos?codigo=4623': [
      { ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } },
      { ok: true, status: 200, data: { data: [] } }
    ],
    'GET /orcamentos/392509025': [{ ok: true, status: 200, data: { data: proposal } }],
    'DELETE /orcamentos/392509025': [{ ok: true, status: 200, data: { success: true } }]
  });
  const result = await new ProposalService(betel).deleteByNumber('4623', { confirmed: true, confirmationCode: '4623' });
  assert.equal(result.status, 'success');
  assert.equal(result.delete_succeeded, true);
  assert.equal(result.proposal_absent_after_delete, true);
  assert.equal(betel.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('delete never repeats DELETE when verification is ambiguous', async () => {
  const betel = fakeBetel({
    'GET /orcamentos?codigo=4623': [
      { ok: true, status: 200, data: { data: [{ id: '392509025', codigo: 4623 }] } },
      { ok: false, status: 503, data: { error: 'temporary' } }
    ],
    'GET /orcamentos/392509025': [{ ok: true, status: 200, data: { data: proposal } }],
    'DELETE /orcamentos/392509025': [{ ok: true, status: 200, data: { success: true } }]
  });
  const result = await new ProposalService(betel).deleteByNumber('4623', { confirmed: true, confirmationCode: '4623' });
  assert.equal(result.status, 'success_unverified');
  assert.equal(result.delete_succeeded, true);
  assert.equal(betel.calls.filter(call => call.method === 'DELETE').length, 1);
});
