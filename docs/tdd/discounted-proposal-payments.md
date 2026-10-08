# Desconto nos totais de propostas

Jornada derivada da falha de produção enviada em 2026-10-08: criar locação com 10 itens de R$ 2.800 e desconto de 10%, mantendo parcelas e introdução no total líquido de R$ 25.200.

- RED: `node --test test/proposal-discount-total.test.mjs` reproduziu total bruto de 28000 em vez de 25200, inclusive na parcela e introdução.
- GREEN: o mesmo alvo passou após extrair `proposal-totals.js` e atualizar ambos os pontos de cálculo do servidor.
- Integração HTTP: servidor real, ERP HTTP local simulado, uma escrita, parcela 25200.00, vencimento 2026-11-07, desconto preservado e frete formal zero. Nenhuma escrita em ERP real.
- `npm test`: 49 testes aprovados, zero falhas e zero skips.
- Cobertura do módulo: `node --test --experimental-test-coverage --test-coverage-include=proposal-totals.js test/proposal-discount-total.test.mjs`: linhas 100%, funções 100%, branches 97.50%.

Cobertura comportamental: descontos percentuais, sem desconto, 100%, descontos monetários, quantidade fracionária, valores brasileiros, produtos e serviços, centavos, dados inválidos, introdução, parcela e rota HTTP. A criação autenticada em produção permanece sem execução nesta validação; estes testes não afirmam confirmação real no ERP.
