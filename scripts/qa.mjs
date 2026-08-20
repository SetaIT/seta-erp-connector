import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (err) { fail(`${path}: JSON invalido - ${err.message}`); return null; }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const action = readJson('openapi-actions.json');
if (action) {
  if (!String(action.openapi || '').startsWith('3.')) fail('openapi-actions.json: versao OpenAPI deve ser 3.x');
  if (!action.info?.version) fail('openapi-actions.json: info.version ausente');
  if (!action.paths || typeof action.paths !== 'object') fail('openapi-actions.json: paths ausente');

  const operationIds = new Map();
  const requiredOps = new Set([
    'verificarSaudeAgentePropostas',
    'consultarOrcamentoPorNumero',
    'consultarContextoCompletoProposta',
    'consultarOrcamento',
    'editarOrcamento',
    'excluirOrcamento',
    'criarOrcamento',
    'buscarClientes',
    'buscarProdutos',
    'buscarNegocioPorProposta',
    'criarNegocioHubSpotDaProposta'
  ]);

  for (const [path, pathItem] of Object.entries(action.paths || {})) {
    for (const method of ['get','post','put','patch','delete']) {
      const op = pathItem?.[method];
      if (!op) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) fail(`${label}: operationId ausente`);
      else {
        if (operationIds.has(op.operationId)) fail(`${label}: operationId duplicado ${op.operationId}`);
        operationIds.set(op.operationId, label);
      }
      if (typeof op.description === 'string' && op.description.length > 300) {
        fail(`${label}: description possui ${op.description.length} caracteres; limite do Builder = 300`);
      }
      if (typeof op.summary === 'string' && op.summary.length > 120) {
        warn(`${label}: summary possui ${op.summary.length} caracteres; considere reduzir`);
      }
    }
  }

  for (const op of requiredOps) if (!operationIds.has(op)) fail(`operacao obrigatoria ausente: ${op}`);

  const primary = action.paths?.['/erp/orcamentos/numero/{numero}']?.get;
  assert(primary?.operationId === 'consultarOrcamentoPorNumero', 'rota primaria por numero comercial nao esta configurada corretamente');
  assert(primary?.parameters?.some(p => p.name === 'numero' && p.in === 'path' && p.required === true), 'consultarOrcamentoPorNumero: parametro de path numero obrigatorio ausente');

  const context = action.paths?.['/erp/propostas/{numero}/contexto']?.get;
  if (context?.description && !/depois|somente|nao use como primeira/i.test(context.description)) {
    warn('consultarContextoCompletoProposta: descricao nao deixa claro que a rota e secundaria ao lookup por numero');
  }

  const edit = action.paths?.['/erp/orcamentos/{id}']?.put;
  assert(edit?.operationId === 'editarOrcamento', 'PUT /erp/orcamentos/{id} nao esta exposto como editarOrcamento');
  const editSchema = action.components?.schemas?.OrcamentoEditInput;
  assert(editSchema?.required?.includes('confirmacao_edicao'), 'OrcamentoEditInput deve exigir confirmacao_edicao');
  assert(editSchema?.properties?.confirmacao_edicao?.const === true, 'confirmacao_edicao deve aceitar somente true');

  const deletion = action.paths?.['/erp/orcamentos/{id}']?.delete;
  assert(deletion?.operationId === 'excluirOrcamento', 'DELETE /erp/orcamentos/{id} nao esta exposto como excluirOrcamento');
  const deleteSchema = action.components?.schemas?.OrcamentoDeleteInput;
  assert(deleteSchema?.required?.includes('confirmacao_exclusao'), 'OrcamentoDeleteInput deve exigir confirmacao_exclusao');
  assert(deleteSchema?.required?.includes('codigo_confirmacao'), 'OrcamentoDeleteInput deve exigir codigo_confirmacao');
  assert(deleteSchema?.properties?.confirmacao_exclusao?.const === true, 'confirmacao_exclusao deve aceitar somente true');

  const emailSchema = action.components?.schemas?.EmailEnviadoInput;
  if (emailSchema) {
    assert(emailSchema?.required?.includes('envio_confirmado'), 'EmailEnviadoInput deve exigir envio_confirmado');
    assert(emailSchema?.properties?.envio_confirmado?.const === true, 'envio_confirmado deve aceitar somente true');
  }

  const sentSchema = action.components?.schemas?.PropostaEnviadaInput;
  if (sentSchema) {
    assert(sentSchema?.required?.includes('envio_confirmado'), 'PropostaEnviadaInput deve exigir envio_confirmado');
    assert(sentSchema?.properties?.envio_confirmado?.const === true, 'PropostaEnviadaInput.envio_confirmado deve aceitar somente true');
  }

  const wonSchema = action.components?.schemas?.GanhoInput;
  if (wonSchema) {
    assert(wonSchema?.required?.includes('confirmacao_ganho'), 'GanhoInput deve exigir confirmacao_ganho');
    assert(wonSchema?.properties?.confirmacao_ganho?.const === true, 'confirmacao_ganho deve aceitar somente true');
  }
}

for (const file of ['gateway.js','read-diagnostics-preload.js','edit-diagnostics-preload.js']) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (err) { fail(`${file}: falha de sintaxe JavaScript - ${String(err.stderr || err.message).trim()}`); }
}

for (const file of ['proposal-rules.json','billing-rules.json']) readJson(file);

for (const warning of warnings) console.log(`WARN: ${warning}`);
if (failures.length) {
  console.error('\nQA REPROVADO');
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`QA APROVADO: ${operationIdsCount(action)} operacoes OpenAPI verificadas; contratos, sintaxe e JSON validados.`);

function operationIdsCount(spec) {
  let count = 0;
  for (const item of Object.values(spec?.paths || {})) {
    for (const method of ['get','post','put','patch','delete']) if (item?.[method]) count++;
  }
  return count;
}
