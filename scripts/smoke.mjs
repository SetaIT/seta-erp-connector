const baseUrl = (process.env.SMOKE_BASE_URL || '').replace(/\/$/, '');
const apiKey = process.env.CONNECTOR_API_KEY || '';
const proposalNumber = process.env.SMOKE_PROPOSAL_NUMBER || '';
const expectedCommit = String(process.env.EXPECTED_DEPLOY_COMMIT || '').trim();
const waitSeconds = Math.max(30, Number(process.env.DEPLOY_WAIT_SECONDS || 600));
const pollSeconds = Math.max(5, Number(process.env.DEPLOY_POLL_SECONDS || 15));
const checkHubSpot = String(process.env.SMOKE_HUBSPOT || 'true').toLowerCase() !== 'false';

if (!baseUrl) {
  console.error('SMOKE REPROVADO: SMOKE_BASE_URL nao configurada.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function sameCommit(actual, expected) {
  if (!actual || !expected) return false;
  const a = String(actual).trim().toLowerCase();
  const e = String(expected).trim().toLowerCase();
  return a === e || a.startsWith(e) || e.startsWith(a);
}

if (expectedCommit) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastInfo = null;
  console.log(`Aguardando deploy do commit ${expectedCommit} por ate ${waitSeconds}s...`);

  while (Date.now() < deadline) {
    try {
      const info = await request('/deployment-info', { auth: false });
      lastInfo = info.body;
      if (info.response.ok && info.body?.status === 'ok' && sameCommit(info.body?.deployment_commit, expectedCommit)) {
        console.log(`OK deploy confirmado para commit ${info.body.deployment_commit}`);
        break;
      }
      console.log(`Deploy ainda nao confirmado. Commit ativo: ${info.body?.deployment_commit || 'indisponivel'}`);
    } catch (err) {
      console.log(`Deploy ainda indisponivel: ${err.message}`);
    }
    await sleep(pollSeconds * 1000);
  }

  if (!sameCommit(lastInfo?.deployment_commit, expectedCommit)) {
    console.error('SMOKE REPROVADO: o commit esperado nao ficou ativo dentro da janela de espera.', {
      expected_commit: expectedCommit,
      active_commit: lastInfo?.deployment_commit || null,
      deployment_info: lastInfo
    });
    process.exit(1);
  }
}

const health = await request('/health', { auth: false });
if (!health.response.ok || health.body?.status !== 'ok') {
  console.error('SMOKE REPROVADO: /health nao confirmou status ok', health.response.status, health.body);
  process.exit(1);
}
console.log('OK /health');

if (checkHubSpot) {
  if (!apiKey) {
    console.error('SMOKE REPROVADO: CONNECTOR_API_KEY nao configurada; nao foi possivel validar HubSpot.');
    process.exit(1);
  }
  const hubspot = await request('/erp/hubspot/health');
  if (!hubspot.response.ok || hubspot.body?.status !== 'ok' || hubspot.body?.hubspot?.authenticated !== true) {
    console.error('SMOKE REPROVADO: HubSpot nao confirmou autenticacao operacional', hubspot.response.status, hubspot.body);
    process.exit(1);
  }
  console.log('OK HubSpot autenticado');
}

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

console.log('SMOKE APROVADO: deploy, health e integracoes configuradas foram validados sem gravacao.');
