import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = {
  DEV_MODE: process.env.DEV_MODE,
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_PRODUCTION_WRITES: process.env.ALLOW_PRODUCTION_WRITES,
};

function restore() {
  globalThis.fetch = originalFetch;
  delete globalThis.__SETA_DEV_WRITE_GUARD__;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('DEV guard blocks external writes while allowing reads and internal writes', async t => {
  t.after(restore);

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), method: String(init.method || 'GET').toUpperCase() });
    return { ok: true, status: 200 };
  };

  process.env.DEV_MODE = 'true';
  process.env.APP_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_PRODUCTION_WRITES = 'false';

  await import(`../dev-write-guard-preload.js?test=${Date.now()}`);

  await globalThis.fetch('https://api.hubapi.com/crm/v3/objects/deals', { method: 'GET' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');

  await globalThis.fetch('http://seta-service.railway.internal/internal-sync', { method: 'POST' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');

  await assert.rejects(
    globalThis.fetch('https://api.hubapi.com/crm/v3/objects/deals', { method: 'POST', body: '{}' }),
    error => error?.code === 'DEV_WRITE_BLOCKED' && error?.status === 423,
  );

  await assert.rejects(
    globalThis.fetch('https://api.beteltecnologia.com/api/orcamentos/123', { method: 'PUT', body: '{}' }),
    error => error?.code === 'DEV_WRITE_BLOCKED',
  );

  await assert.rejects(
    globalThis.fetch('https://graph.microsoft.com/v1.0/users/test/sendMail', { method: 'POST', body: '{}' }),
    error => error?.code === 'DEV_WRITE_BLOCKED',
  );

  assert.equal(calls.length, 2, 'blocked requests must never reach the underlying fetch');
});
