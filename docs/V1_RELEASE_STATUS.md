# V1 Connector Release Status

## Estado

O conector V1 está tecnicamente pronto para promoção, mantendo as escritas externas bloqueadas no ambiente Developer.

## Mudanças concluídas

- write guard para ERP, HubSpot e Outlook no Developer;
- branding de e-mail incorporado diretamente em `gateway.js`;
- remoção do patch de branding do comando de startup;
- preservação da reconciliação pós-write;
- cobertura dos estados efetivos de escrita:
  - `SUCCESS`
  - `SUCCESS_RECOVERED`
  - `FAILED`
  - `WRITE_UNCERTAIN`
- documentação da dívida técnica e dos preloads;
- ativos de mock para validação isolada.

## Evidência

Railway Developer validado com:

- deployment em `SUCCESS`;
- healthcheck `/health` aprovado;
- 27 testes automatizados;
- 27 aprovados;
- 0 falhas.

## Regra de segurança

As credenciais do ambiente Developer podem alcançar serviços reais. Por isso, `ALLOW_PRODUCTION_WRITES=false` e os modos de escrita de ERP, HubSpot e e-mail permanecem desabilitados.

Nenhum teste de escrita real deve ser liberado automaticamente.

## Promoção

PR de promoção: #36, `stabilization/v1` -> `main`.

Antes do merge para produção:

1. confirmar o último deploy Developer em `SUCCESS`;
2. manter os testes sem falhas;
3. confirmar autorização explícita para produção;
4. monitorar logs após o deploy;
5. preservar o checkpoint de rollback criado antes do roadmap.
