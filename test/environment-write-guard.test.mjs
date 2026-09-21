import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockExternalWrite } from '../environment-write-guard-preload.js';

const env = {
  ALLOW_PRODUCTION_WRITES: 'false',
  ERP_WRITE_MODE: 'disabled',
  HUBSPOT_WRITE_MODE: 'disabled',
  EMAIL_SEND_MODE: 'disabled',
  BETEL_BASE_URL: 'https://api.betel.example',
  HUBSPOT_BASE_URL: 'https://api.hubapi.com',
};

test('bloqueia escrita no ERP externo', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://api.betel.example/orcamentos/123',
    init: { method: 'PUT' },
    env,
  });
  assert.equal(result?.system, 'erp');
});

test('permite leitura GET no ERP', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://api.betel.example/orcamentos/123',
    init: { method: 'GET' },
    env,
  });
  assert.equal(result, null);
});

test('permite POST de pesquisa do HubSpot', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://api.hubapi.com/crm/v3/objects/companies/search',
    init: { method: 'POST' },
    env,
  });
  assert.equal(result, null);
});

test('bloqueia PATCH de negócio no HubSpot', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://api.hubapi.com/crm/v3/objects/deals/456',
    init: { method: 'PATCH' },
    env,
  });
  assert.equal(result?.system, 'hubspot');
});

test('bloqueia envio de e-mail pelo Microsoft Graph', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://graph.microsoft.com/v1.0/users/user@example.com/sendMail',
    init: { method: 'POST' },
    env,
  });
  assert.equal(result?.system, 'outlook');
});

test('permite chamadas internas entre serviços Railway', () => {
  const result = shouldBlockExternalWrite({
    input: 'http://seta-erp-connector-v1-dev.railway.internal:8080/erp/orcamentos',
    init: { method: 'POST' },
    env,
  });
  assert.equal(result, null);
});

test('a autorização explícita libera as escritas', () => {
  const result = shouldBlockExternalWrite({
    input: 'https://api.betel.example/orcamentos/123',
    init: { method: 'DELETE' },
    env: { ...env, ALLOW_PRODUCTION_WRITES: 'true' },
  });
  assert.equal(result, null);
});
