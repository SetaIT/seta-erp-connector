import test from 'node:test';
import assert from 'node:assert/strict';
import { capturarSolicitacaoDevHtml } from '../capturar-solicitacao-dev-ui.js';

test('DEV UI exposes safe Capturar Solicitação review flow', () => {
  const html = capturarSolicitacaoDevHtml();
  assert.match(html, /Capturar Solicitação/);
  assert.match(html, /AMBIENTE DEV · SEM GRAVAÇÃO/);
  assert.match(html, /\/dev\/capturar-solicitacao\/dry-run/);
  assert.match(html, /Texto da conversa/);
  assert.match(html, /CNPJ/);
  assert.match(html, /Modalidade/);
  assert.match(html, /Produto \/ descrição/);
  assert.match(html, /ERP, HubSpot e envio de e-mail permanecem bloqueados/);
  assert.doesNotMatch(html, /ALLOW_PRODUCTION_WRITES=true/);
});
