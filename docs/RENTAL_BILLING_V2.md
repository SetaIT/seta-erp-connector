# Faturamento de locacoes V2 - servico isolado

## Protecao do ERP MCP existente

Esta versao nao altera `server.js`, `gateway.js`, os preloads existentes nem os OpenAPI atuais. O faturamento roda em processo e deploy separados por meio de `rental-billing-service.js`.

O servico existente continua no commit-base `f580f242cf2c172bf29aac958d6b3890eb1b8f43`. O snapshot anterior esta preservado na branch `backup/pre-rental-billing-v2-20260825`.

## Fluxo

1. `POST /erp/locacoes/faturamento/preflight` valida os campos e procura duplicidade sem gravar.
2. `POST /erp/locacoes/faturamento/executar` exige `confirmacao_gravacao: true`.
3. O recebimento e criado primeiro.
4. A NFS-e e sempre criada em aberto com `envio_automatico: 0`.
5. A emissao exige `emitir_nfse: true` e `confirmacao_emissao: true`.

Cada competencia usa uma chave de idempotencia unica, gravada nas descricoes como `[SETA-LOCACAO:<chave>]`.

## Separacao no n8n

O workflow financeiro deve ser independente do Supervisor Comercial. O Supervisor pode chama-lo, mas nao recebe permissao para emitir NFS-e sem a segunda confirmacao.

## Politica de versao e backup

Antes de cada nova versao:

1. registrar o SHA de origem;
2. criar `backup/pre-rental-billing-vX-AAAAMMDD` apontando para esse SHA;
3. desenvolver em `feat/rental-billing-vX-isolated`;
4. executar QA e testes somente com mocks;
5. abrir PR sem merge automatico;
6. implantar apenas apos aprovacao explicita.
