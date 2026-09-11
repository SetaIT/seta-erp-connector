import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntakeLookupPlan, normalizeCommercialIntake } from '../capturar-solicitacao-core.js';

test('normalizes a rental request extracted from a conversation', () => {
  const result = normalizeCommercialIntake({
    origem: 'whatsapp_screenshot',
    empresa: { nome: 'Empresa ABC', cnpj: '12.345.678/0001-90' },
    contato: { nome: 'Joao', email: 'JOAO@ABC.COM.BR', whatsapp: '(11) 99999-0000' },
    contexto: 'Preciso de locacao por 36 meses',
    prazo_meses: 36,
    itens: [{ descricao: 'Switch Cisco 48 portas PoE', quantidade: 3 }],
    observacoes: 'Cliente pediu proposta ate sexta-feira.'
  });

  assert.equal(result.empresa.cnpj, '12345678000190');
  assert.equal(result.contato.email, 'joao@abc.com.br');
  assert.equal(result.contato.telefone, '5511999990000');
  assert.equal(result.modalidade, 'locacao');
  assert.equal(result.itens[0].quantidade, 3);
  assert.equal(result.requer_revisao, false);
  assert.equal(result.campos_pendentes.length, 0);
});

test('flags incomplete ambiguous requests for human review', () => {
  const result = normalizeCommercialIntake({
    origem: 'email_screenshot',
    empresa: { nome: 'Cliente XPTO' },
    contato: { nome: 'Maria' },
    itens: [{ descricao: 'Fortigate' }]
  });

  assert.equal(result.requer_revisao, true);
  assert.ok(result.campos_pendentes.includes('modalidade'));
  assert.ok(result.campos_pendentes.includes('itens[0].quantidade'));
});

test('uses the approved company lookup priority', () => {
  const steps = buildIntakeLookupPlan({
    empresa: { cnpj: '12.345.678/0001-90', dominio: 'abc.com.br', nome: 'ABC Ltda' },
    contato: { telefone: '(11) 99999-0000' },
    modalidade: 'venda',
    itens: [{ descricao: 'Servidor', quantidade: 1 }]
  });

  assert.deepEqual(steps.map(step => step.tipo), ['cnpj', 'dominio', 'nome', 'telefone']);
  assert.deepEqual(steps.map(step => step.prioridade), [1, 2, 3, 4]);
});

test('does not create a lookup plan when company clues are absent', () => {
  const steps = buildIntakeLookupPlan({
    modalidade: 'orcamento',
    itens: [{ descricao: 'Notebook', quantidade: 2 }]
  });

  assert.deepEqual(steps, []);
});
