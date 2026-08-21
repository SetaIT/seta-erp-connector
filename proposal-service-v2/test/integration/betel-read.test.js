import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { BetelClient } from '../../src/erp/betel-client.js';
import { ProposalService } from '../../src/services/proposals.js';

const REQUIRED = ['BETEL_ACCESS_TOKEN', 'BETEL_SECRET_ACCESS_TOKEN'];
const missing = REQUIRED.filter(name => !process.env[name]);

if (missing.length) {
  test('Betel integration configuration is available', { skip: `missing: ${missing.join(', ')}` }, () => {});
} else {
  test('reads proposal by commercial number from Betel without writing', async () => {
    const numero = String(process.env.BETEL_TEST_PROPOSAL_NUMBER || '4623');
    const config = loadConfig(process.env);
    const betel = new BetelClient(config);
    const service = new ProposalService(betel);

    const result = await service.getByNumber(numero);

    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.read_succeeded, true, JSON.stringify(result));
    assert.equal(String(result.numero), numero);
    assert.equal(String(result.codigo), numero);
    assert.ok(result._internal?.id, 'internal Betel id should be resolved');
  });
}
