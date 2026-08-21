import { loadConfig } from '../src/config.js';
import { BetelClient } from '../src/erp/betel-client.js';
import { ProposalService } from '../src/services/proposals.js';

const numero = String(process.env.BETEL_TEST_PROPOSAL_NUMBER || process.argv[2] || '4623');
const config = loadConfig(process.env);
const service = new ProposalService(new BetelClient(config));

const result = await service.getByNumber(numero);

const safeResult = { ...result };
if (safeResult._internal) delete safeResult._internal;

console.log(JSON.stringify(safeResult, null, 2));

if (result.status !== 'success' || result.read_succeeded !== true) {
  process.exitCode = 1;
}
