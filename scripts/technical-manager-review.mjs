import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const baseRef = process.env.BASE_REF || 'main';
const headRef = process.env.HEAD_REF || 'HEAD';
const qaStatus = process.env.QA_STATUS || 'unknown';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

let changedFiles = [];
try {
  const output = git(['diff', '--name-only', `origin/${baseRef}...${headRef}`]);
  changedFiles = output ? output.split('\n').filter(Boolean) : [];
} catch {
  const output = git(['diff', '--name-only', 'HEAD~1', 'HEAD']);
  changedFiles = output ? output.split('\n').filter(Boolean) : [];
}

const runtimeFiles = new Set([
  'gateway.js',
  'server.js',
  'read-diagnostics-preload.js',
  'edit-diagnostics-preload.js',
  'package.json',
  'openapi-actions.json',
  'proposal-rules.json',
  'billing-rules.json'
]);

const sensitivePatterns = [
  /^\.github\/workflows\//,
  /auth/i,
  /secret/i,
  /token/i,
  /credential/i,
  /delete/i,
  /billing/i,
  /payment/i
];

const runtimeChanged = changedFiles.filter((file) => runtimeFiles.has(file));
const workflowChanged = changedFiles.filter((file) => file.startsWith('.github/workflows/'));
const docsOnly = changedFiles.length > 0 && changedFiles.every((file) => file.startsWith('docs/') || file.endsWith('.md') || file.startsWith('.github/ISSUE_TEMPLATE/'));
const sensitiveChanged = changedFiles.filter((file) => sensitivePatterns.some((pattern) => pattern.test(file)));

let risk = 'baixo';
if (runtimeChanged.length || workflowChanged.length) risk = 'medio';
if (sensitiveChanged.length || runtimeChanged.includes('gateway.js') || runtimeChanged.includes('openapi-actions.json')) risk = 'alto';

let decision = 'APROVADO_PARA_QA';
let reason = 'Mudanca analisada pelo Gerente Tecnico; QA automatico deve concluir antes do merge.';

if (qaStatus !== 'success') {
  decision = 'CORRIGIR';
  reason = 'QA automatico nao concluiu com sucesso.';
} else if (docsOnly) {
  decision = 'APROVADO_PARA_MERGE';
  reason = 'Alteracao documental sem impacto de runtime e QA aprovado.';
} else if (risk === 'alto') {
  decision = 'APROVADO_PARA_DEPLOY_CONTROLADO';
  reason = 'QA aprovado, mas ha alteracao critica. Exigir deploy observado e smoke test antes de considerar a entrega concluida.';
} else {
  decision = 'APROVADO_PARA_MERGE';
  reason = 'QA aprovado e nao foram detectados riscos altos pelos criterios deterministicos atuais.';
}

const lines = [
  '## Gerente Tecnico ERP - Revisao automatica',
  '',
  `**Decisao:** ${decision}`,
  `**Risco:** ${risk}`,
  `**QA:** ${qaStatus}`,
  '',
  reason,
  '',
  '### Arquivos alterados',
  ...(changedFiles.length ? changedFiles.map((file) => `- \`${file}\``) : ['- Nenhum arquivo detectado']),
  '',
  '### Controles exigidos',
  '- QA estatico aprovado antes do merge.',
  ...(risk === 'alto' ? ['- Deploy observado.', '- Smoke test de producao sem gravacao.', '- Nao declarar entrega concluida sem evidencia do smoke test.'] : []),
  ...(sensitiveChanged.length ? ['- Revisar impacto em autenticacao, exclusao, pagamentos ou secrets conforme aplicavel.'] : []),
  '',
  '> Esta revisao e deterministica. Regras de negocio ambiguas, credenciais novas, operacoes destrutivas reais e mudancas estruturais de alto impacto continuam exigindo decisao humana explicita.'
];

const report = lines.join('\n');
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\nrisk=${risk}\n`);
}

if (decision === 'CORRIGIR') process.exit(1);
