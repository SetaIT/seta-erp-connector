import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECTIVE_STATUS,
  ERROR_TAXONOMY,
  extractDownstreamValidation,
  reconcileWrite,
  resolveEnumOption,
} from '../commercial-write-reconciliation.js';

const base = {
  operation: 'create_proposal',
  endpoint: '/orcamentos',
  correlationId: 'test-correlation-123',
  payload: { codigo: 4632, access_token: 'must-not-leak' },
};

const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), {
  status,
  data,
  endpoint: '/orcamentos',
  operation: 'create_proposal',
});

test('HTTP 201 plus created resource is SUCCESS', async () => {
  const result = await reconcileWrite({
    ...base,
    write: async () => ({ http_status: 201, data: { id: 99, codigo: 4632 } }),
    verify: async () => ({ outcome: 'found', equivalent: true, resource: { id: 99, codigo: 4632 } }),
  });
  assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS);
  assert.equal(result.verification.found, true);
  assert.equal(result.sanitized_payload.access_token, '[REDACTED]');
});

test('HTTP 400 plus created resource is SUCCESS_RECOVERED', async () => {
  const result = await reconcileWrite({
    ...base,
    write: async () => { throw httpError(400, { error: 'late validation response' }); },
    verify: async () => ({ outcome: 'found', equivalent: true, resource: { id: 99, codigo: 4632 } }),
  });
  assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS_RECOVERED);
  assert.equal(result.error_taxonomy, ERROR_TAXONOMY.WRITE_CONFIRMED_AFTER_ERROR);
  assert.deepEqual(result.downstream_response, { error: 'late validation response' });
  assert.equal(result.downstream_message, 'late validation response');
});

test('HTTP 400 plus confirmed absence exposes Betel validation message and fields', async () => {
  let attempts = 0;
  const result = await reconcileWrite({
    ...base,
    write: async () => {
      attempts += 1;
      throw httpError(400, {
        status: 'error',
        errors: [
          { campo: 'situacao_id', mensagem: 'Situacao invalida para o orcamento' },
          { field: 'produtos.0.valor_venda', message: 'Valor de venda deve ser maior que zero' },
        ],
      });
    },
    verify: async () => ({ outcome: 'absent' }),
  });
  assert.equal(attempts, 1);
  assert.equal(result.effective_status, EFFECTIVE_STATUS.FAILED);
  assert.equal(result.error_taxonomy, ERROR_TAXONOMY.DOWNSTREAM_REJECTED);
  assert.equal(result.downstream_message, 'Situacao invalida para o orcamento');
  assert.deepEqual(result.validation_errors, [
    { field: 'situacao_id', message: 'Situacao invalida para o orcamento' },
    { field: 'produtos.0.valor_venda', message: 'Valor de venda deve ser maior que zero' },
  ]);
  assert.equal(result.downstream_error.message, 'Situacao invalida para o orcamento');
});

test('extractDownstreamValidation handles nested Betel payloads and redacts secrets', () => {
  const result = extractDownstreamValidation({
    data: {
      validacao: {
        erros: [{ atributo: 'cliente_id', descricao: 'Cliente nao encontrado', token: 'secret' }],
      },
    },
  });
  assert.equal(result.downstream_message, 'Cliente nao encontrado');
  assert.deepEqual(result.validation_errors, [
    { field: 'cliente_id', message: 'Cliente nao encontrado' },
  ]);
});

test('timeout plus created resource is SUCCESS_RECOVERED', async () => {
  const timeout = Object.assign(new Error('request timeout'), { name: 'TimeoutError' });
  const result = await reconcileWrite({
    ...base,
    write: async () => { throw timeout; },
    verify: async () => ({ outcome: 'found', equivalent: true, resource: { codigo: 4632 } }),
  });
  assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS_RECOVERED);
});

test('timeout plus inconclusive read is WRITE_UNCERTAIN', async () => {
  const timeout = Object.assign(new Error('request timeout'), { name: 'TimeoutError' });
  const result = await reconcileWrite({
    ...base,
    write: async () => { throw timeout; },
    verify: async () => ({ outcome: 'inconclusive', details: { reason: 'read timeout' } }),
  });
  assert.equal(result.effective_status, EFFECTIVE_STATUS.WRITE_UNCERTAIN);
  assert.equal(result.error_taxonomy, ERROR_TAXONOMY.WRITE_UNCERTAIN);
});

test('Deal direct create response remains SUCCESS when search is temporarily zero', async () => {
  const result = await reconcileWrite({
    ...base,
    operation: 'create_hubspot_deal',
    endpoint: '/crm/v3/objects/deals',
    acceptDirectEvidence: true,
    directEvidence: (value) => Boolean(value?.id),
    write: async () => ({ http_status: 201, data: { id: 'deal-1', properties: { numero_da_proposta: '4632' } } }),
    verify: async () => ({ outcome: 'absent', details: { total: 0 } }),
  });
  assert.equal(result.effective_status, EFFECTIVE_STATUS.SUCCESS);
  assert.equal(result.error_taxonomy, ERROR_TAXONOMY.EVENTUAL_CONSISTENCY);
});

test('HubSpot solution alias resolves to internal Cisco and invalid enum is rejected before write', () => {
  const options = [{ label: 'Cisco', value: 'Cisco' }, { label: 'Fortinet', value: 'Fortinet' }];
  assert.equal(resolveEnumOption('solucao', 'Locação de Switch', options, {
    solucao: { 'locacao de switch': 'Cisco' },
  }), 'Cisco');
  assert.throws(
    () => resolveEnumOption('solucao', 'Unknown solution', options),
    (error) => error.taxonomy === ERROR_TAXONOMY.VALIDATION_ERROR,
  );
});
