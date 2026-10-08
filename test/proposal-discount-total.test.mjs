import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyConfiguredPaymentTerms } from '../proposal-payment-terms.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const moduleUrl = new URL('../proposal-totals.js', import.meta.url);
const calculateProposalTotal = fs.existsSync(moduleUrl)
  ? (await import(moduleUrl)).calculateProposalTotal : undefined;
function definition(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in server`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
const total = new Function('calculateProposalTotal',
  `${definition('requestError')}\n${definition('parseMoney')}\n${definition('proposalTotal')}\nreturn proposalTotal;`
)(calculateProposalTotal);
const item = (quantity, price, discount = '0', extra = {}) => ({ produto: {
  id: '90993663', quantidade: String(quantity), valor_venda: String(price),
  tipo_desconto: '%', desconto_porcentagem: String(discount), ...extra,
} });

test('R640: 10 x 2800 with 10 percent discount totals 25200', () => {
  assert.equal(total([item(10, 2800, 10)]), 25200);
});
test('keeps undiscounted proposals unchanged', () => {
  assert.equal(total([item(10, 2800)]), 28000);
});
test('adds discounted products and services', () => {
  assert.equal(total([item(2, 100, 10)], [{ servico: {
    quantidade: '3', valor_venda: '10', tipo_desconto: '%', desconto_porcentagem: '50',
  } }]), 195);
});
test('supports service-only proposals', () => {
  assert.equal(total([], [{ servico: { quantidade: '2', valor_venda: '100', desconto_porcentagem: '10', tipo_desconto: '%' } }]), 180);
});
test('rounds each net line to cents before summing', () => {
  assert.equal(total([item(1, 0.05, 10), item(1, 0.05, 10)]), 0.10);
});
test('100 percent discount gives zero', () => {
  assert.equal(total([item(1, 100, 100)]), 0);
});
test('rejects missing items, malformed arrays and negative values', () => {
  for (const [products, services] of [[[], []], [null, []], [[null], []], [[item(-1, 100)], []], [[item(1, -100)], []], [[item(1, 100, 0, { tipo_desconto: 'R$', desconto_valor: 101 })], []]]) {
    assert.throws(() => total(products, services));
  }
});
test('defaults optional quantities and empty discounts without changing prices', () => {
  assert.equal(total([{ produto: { valor_venda: '100', desconto_porcentagem: '' } }]), 100);
  assert.equal(total([{ valor_venda: '50', desconto: '10', quantidade: null }]), 45);
});
test('rejects invalid percentage instead of writing inconsistent payments', () => {
  for (const discount of ['101', '-1', 'abc']) assert.throws(() => total([item(1, 100, discount)]));
});
test('currency discount takes precedence over unused percentage', () => {
  assert.equal(total([item(2, 100, 50, { tipo_desconto: 'R$', desconto_valor: '25' })]), 175);
});
test('supports decimal quantity and BRL input', () => {
  assert.equal(total([item('1,5', '2.800,00', '10')]), 3780);
});
test('configured payment terms use the same net total and preserve the due date', () => {
  const result = applyConfiguredPaymentTerms({
    body: { data: '2026-10-08', forma_pagamento_id: '6321209' },
    total: total([item(10, 2800, 10)]),
    paymentTerms: { numero_parcelas: 1, vencimento_dias_apos_data_proposta: 30, condicao_pagamento: 'a_vista' },
  });
  assert.equal(result.body.pagamentos[0].pagamento.valor, '25200.00');
  assert.equal(result.body.pagamentos[0].pagamento.data_vencimento, '2026-11-07');
});
test('commercial introduction uses the same net total', () => {
  const build = new Function('proposalTotal', 'getProposalTypeRule', 'summarizeProposalItems',
    `${definition('parseMoney')}\n${definition('formatProposalMoney')}\n${definition('buildProposalIntroduction')}\nreturn buildProposalIntroduction;`
  )(total, () => ({ rules: {}, typeKey: 'locacao', typeRule: { introduction_pattern: 'Valor mensal: {valor_formatado}' } }), () => '');
  const result = build({ tipo_proposta: 'locacao', solucao: 'Servidor', produtos: [item(10, 2800, 10)] });
  assert.equal(result.metadata.valor_calculado, 25200);
  assert.match(result.introduction, /25\.200,00/);
});
