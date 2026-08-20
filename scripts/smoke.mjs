const baseUrl = (process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
const apiKey = process.env.CONNECTOR_API_KEY || '';
const proposalNumber = process.env.SMOKE_PROPOSAL_NUMBER || '';

if (!baseUrl) {
  console.log('SMOKE SKIPPED: SMOKE_BASE_URL nao configurada.');
  process.exit(0);
}

async function request(path, { auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) {
    if (!apiKey) throw new Error('CONNECTOR_API_KEY ausente para smoke autenticado');
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { response, body };
}

const health = await request('/health', { auth: false });
if (!health.response.ok || health.body?.status !== 'ok') {
  console.error('SMOKE REPROVADO: /health nao confirmou status ok', health.response.status, health.body);
  process.exit(1);
}
console.log('OK /health');

if (proposalNumber) {
  const proposal = await request(`/erp/orcamentos/numero/${encodeURIComponent(proposalNumber)}`);
  if (!proposal.response.ok || proposal.body?.read_succeeded !== true || String(proposal.body?.codigo ?? '') !== String(proposalNumber)) {
    console.error('SMOKE REPROVADO: consulta por numero comercial falhou', proposal.response.status, proposal.body);
    process.exit(1);
  }
  console.log(`OK proposta ${proposalNumber} consultada pelo numero comercial`);
} else {
  console.log('SMOKE INFO: SMOKE_PROPOSAL_NUMBER nao configurado; consulta ERP por numero nao executada.');
}

console.log('SMOKE APROVADO');
