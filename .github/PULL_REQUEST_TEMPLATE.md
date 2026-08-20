# ERP / Agente de Propostas - Pull Request

## Objetivo
Descreva em linguagem de negocio o que esta mudando e qual problema resolve.

## Criterios de aceite
- [ ] O comportamento esperado esta descrito e testavel.
- [ ] Nao foram inventados IDs, links, valores ou resultados de API.
- [ ] Alteracoes comerciais irreversiveis continuam exigindo preview e confirmacao explicita.
- [ ] Propostas existentes continuam sendo localizadas primeiro pelo numero comercial.
- [ ] O usuario nao precisa fornecer ID interno do ERP.

## Evidencias tecnicas
- [ ] `npm run qa` executado com sucesso.
- [ ] OpenAPI valido e descriptions dentro do limite do Builder.
- [ ] Sintaxe dos processos principais validada.
- [ ] Contratos criticos de confirmacao validados.
- [ ] Testes adicionais/regressao executados quando aplicavel.

## Deploy e smoke
- [ ] Deploy realizado ou marcado como nao aplicavel.
- [ ] Healthcheck validado apos deploy quando aplicavel.
- [ ] Smoke test sem gravacao executado quando aplicavel.
- [ ] Falhas externas foram diferenciadas de falhas de codigo/configuracao.

## Risco residual
Liste qualquer risco conhecido, dependencia externa, limitacao ou etapa manual que ainda exista.

## Decisao do Gerente Tecnico
- [ ] APROVAR
- [ ] SOLICITAR CORRECAO
- [ ] BLOQUEADO POR TERCEIRO
- [ ] REQUER DECISAO HUMANA
