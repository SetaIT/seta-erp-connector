import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHubSpotDealDeleteInput,
  executeHubSpotDealDelete,
} from '../hubspot-deal-delete-preload.js';

test('validateHubSpotDealDeleteInput accepts numeric HubSpot ID with double confirmation', () => {
  assert.equal(
    validateHubSpotDealDeleteInput('64382221879', {
      confirmacao_exclusao: true,
      codigo_confirmacao: '64382221879',
    }),
    '64382221879',
  );
});

test('validateHubSpotDealDeleteInput rejects non numeric deal_id', () => {
  assert.throws(
    () => validateHubSpotDealDeleteInput('PROP-4633', {
      confirmacao_exclusao: true,
      codigo_confirmacao: 'PROP-4633',
    }),
    /ID interno numerico do HubSpot/,
  );
});

test('validateHubSpotDealDeleteInput requires confirmacao_exclusao true', () => {
  assert.throws(
    () => validateHubSpotDealDeleteInput('64382221879', {
      codigo_confirmacao: '64382221879',
    }),
    /confirmacao_exclusao/,
  );
});

test('validateHubSpotDealDeleteInput requires codigo_confirmacao equal to deal_id', () => {
  assert.throws(
    () => validateHubSpotDealDeleteInput('64382221879', {
      confirmacao_exclusao: true,
      codigo_confirmacao: '4633',
    }),
    /codigo_confirmacao/,
  );
});

test('executeHubSpotDealDelete confirms successful deletion by post-delete 404', async () => {
  const calls = [];
  let readCount = 0;
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', correlationId: options.correlationId });
    if ((options.method || 'GET') === 'DELETE') {
      return { http_status: 204, data: null, request_id: 'delete-request' };
    }
    readCount += 1;
    if (readCount === 1) {
      return {
        http_status: 200,
        request_id: 'preview-request',
        data: { id: '64382221879', properties: { dealname: 'Teste' } },
      };
    }
    const error = new Error('HubSpot API error 404');
    error.status = 404;
    error.request_id = 'verify-request';
    throw error;
  };

  const result = await executeHubSpotDealDelete({
    dealId: '64382221879',
    body: { confirmacao_exclusao: true, codigo_confirmacao: '64382221879' },
    correlationId: 'corr-123',
    request,
  });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.payload.status, 'success');
  assert.equal(result.payload.effective_status, 'SUCCESS');
  assert.equal(result.payload.verification.confirmed_absent, true);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'DELETE', 'GET']);
  assert.ok(calls.every(call => call.correlationId === 'corr-123'));
  assert.ok(calls.every(call => !call.path.includes('/companies/') && !call.path.includes('/contacts/')));
});

test('executeHubSpotDealDelete recovers when DELETE errors but verification confirms 404', async () => {
  let readCount = 0;
  const request = async (_path, options = {}) => {
    if ((options.method || 'GET') === 'DELETE') {
      const error = new Error('network error after write');
      error.status = 500;
      error.request_id = 'delete-error';
      throw error;
    }
    readCount += 1;
    if (readCount === 1) return { http_status: 200, data: { id: '64382221879' } };
    const error = new Error('HubSpot API error 404');
    error.status = 404;
    throw error;
  };

  const result = await executeHubSpotDealDelete({
    dealId: '64382221879',
    body: { confirmacao_exclusao: true, codigo_confirmacao: '64382221879' },
    correlationId: 'corr-456',
    request,
  });

  assert.equal(result.payload.status, 'success');
  assert.equal(result.payload.effective_status, 'SUCCESS_RECOVERED');
  assert.equal(result.payload.delete_evidence.recovered_after_error, true);
});

test('executeHubSpotDealDelete returns FAILED when DELETE errors and deal is confirmed present', async () => {
  let readCount = 0;
  const request = async (_path, options = {}) => {
    if ((options.method || 'GET') === 'DELETE') {
      const error = new Error('HubSpot API error 400');
      error.status = 400;
      throw error;
    }
    readCount += 1;
    return { http_status: 200, data: { id: '64382221879', readCount } };
  };

  const result = await executeHubSpotDealDelete({
    dealId: '64382221879',
    body: { confirmacao_exclusao: true, codigo_confirmacao: '64382221879' },
    correlationId: 'corr-789',
    request,
  });

  assert.equal(result.httpStatus, 409);
  assert.equal(result.payload.status, 'failed');
  assert.equal(result.payload.effective_status, 'FAILED');
  assert.equal(result.payload.verification.outcome, 'still_exists');
});

test('executeHubSpotDealDelete returns WRITE_UNCERTAIN when verification is inconclusive', async () => {
  let readCount = 0;
  const request = async (_path, options = {}) => {
    if ((options.method || 'GET') === 'DELETE') return { http_status: 204, data: null };
    readCount += 1;
    if (readCount === 1) return { http_status: 200, data: { id: '64382221879' } };
    const error = new Error('verification unavailable');
    error.status = 503;
    throw error;
  };

  const result = await executeHubSpotDealDelete({
    dealId: '64382221879',
    body: { confirmacao_exclusao: true, codigo_confirmacao: '64382221879' },
    correlationId: 'corr-uncertain',
    request,
  });

  assert.equal(result.httpStatus, 202);
  assert.equal(result.payload.status, 'write_uncertain');
  assert.equal(result.payload.effective_status, 'WRITE_UNCERTAIN');
  assert.match(result.payload.note, /Nao repetir/);
});
