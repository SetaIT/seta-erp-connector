import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConfiguredPaymentTerms } from '../proposal-payment-terms.js';

const terms = {
  condicao_pagamento: 'a_vista',
  numero_parcelas: 1,
  vencimento_dias_apos_data_proposta: 30,
  exibir_pagamento: true
};

test('aplica regra de pagamento de locacao/spareparts com uma parcela em 30 dias', () => {
  const result = applyConfiguredPaymentTerms({
    body: {
      data: '2026-10-07',
      forma_pagamento_id: '6321209',
      pagamentos: [{
        pagamento: {
          data_vencimento: '2026-10-08',
          valor: '999.99',
          forma_pagamento_id: '6321209',
          plano_contas_id: '4878064',
          pedido_id: 'registro-antigo'
        }
      }]
    },
    total: 36327,
    paymentTerms: terms
  });

  assert.equal(result.applied, true);
  assert.equal(result.body.condicao_pagamento, 'a_vista');
  assert.equal(result.body.numero_parcelas, '1');
  assert.equal(result.body.data_primeira_parcela, '2026-11-06');
  assert.equal(result.body.intervalo_dias, '0');
  assert.equal(result.body.exibir_pagamento, '1');
  assert.equal(result.body.pagamentos.length, 1);
  assert.deepEqual(result.body.pagamentos[0].pagamento, {
    data_vencimento: '2026-11-06',
    valor: '36327.00',
    forma_pagamento_id: '6321209',
    plano_contas_id: '4878064'
  });
  assert.equal(result.metadata.valor_parcela, '36327.00');
});

test('nao inventa forma de pagamento quando ela nao foi selecionada', () => {
  const result = applyConfiguredPaymentTerms({
    body: { data: '2026-10-07' },
    total: 100,
    paymentTerms: terms
  });

  assert.equal(result.body.forma_pagamento_id, undefined);
  assert.equal(result.body.pagamentos, undefined);
  assert.equal(result.body.data_primeira_parcela, '2026-11-06');
  assert.equal(result.body.numero_parcelas, '1');
});

test('sem payment_terms preserva o corpo', () => {
  const body = { data: '2026-10-07', condicao_pagamento: 'parcelado' };
  const result = applyConfiguredPaymentTerms({ body, total: 100, paymentTerms: null });
  assert.equal(result.applied, false);
  assert.deepEqual(result.body, body);
});
