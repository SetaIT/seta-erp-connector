# Faturamento de locacoes V2.1 - servico isolado endurecido

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

## Controles de seguranca obrigatorios

As gravacoes ficam desabilitadas por padrao. O processo so aceita criar documentos quando:

```text
RENTAL_BILLING_WRITES_ENABLED=true
RENTAL_BILLING_KILL_SWITCH!=true
```

A emissao fiscal possui um segundo bloqueio e exige tambem:

```text
RENTAL_BILLING_EMISSION_ENABLED=true
```

O kill switch prevalece sobre todas as outras configuracoes e bloqueia criacao e emissao imediatamente. O endpoint `/health` publica os tres estados efetivos sem revelar credenciais.

## Ledger persistente e idempotencia atomica

O servico mantem um ledger local em `RENTAL_BILLING_LEDGER_PATH` (padrao: `data/rental-billing-ledger.json`). A reserva e cada transicao usam lock exclusivo de arquivo e substituicao atomica. O arquivo e criado com permissao `0600`.

A chave deve comecar com `<contrato_id>:<AAAA-MM>` e e vinculada permanentemente a:

- contrato;
- cliente;
- competencia;
- hash SHA-256 do payload;
- ID do recebimento;
- ID da NFS-e;
- estado e ultimo erro.

Reutilizar a mesma chave com payload diferente retorna `409`. Requisicoes concorrentes para a mesma chave nao podem adquirir simultaneamente a mesma etapa.

Estados suportados:

```text
reserved
receipt_in_progress -> receipt_created | receipt_failed
nfse_in_progress -> nfse_open | nfse_failed
emission_in_progress -> emitted | emission_failed
```

Uma falha HTTP confirmada usa `*_failed` e pode ser retomada com a mesma chave. Timeout, desconexao ou resposta perdida usa `receipt_unknown`, `nfse_unknown` ou `emission_unknown`. Estados `*_unknown` e `*_in_progress` bloqueiam novas escritas: o registro deve ser reconciliado por consulta antes de qualquer retomada. Isso evita repetir cegamente uma operacao cujo resultado no ERP seja desconhecido.

Todas as chamadas upstream possuem timeout explicito, configuravel por `RENTAL_BILLING_UPSTREAM_TIMEOUT_MS` entre 1 e 60 segundos (padrao: 15 segundos). O preflight percorre todas as paginas declaradas em `meta.total_paginas` para localizar marcadores de NFS-e, com limite defensivo de 1.000 paginas.

O ledger precisa residir em volume persistente, exclusivo de uma instancia escritora. Armazenamento efemero, multiplas replicas com discos independentes ou compartilhamento sem semantica confiavel de lock nao sao aceitos para producao. Para escala horizontal, substituir este backend por banco transacional com constraint unica na chave.

## Validacoes de vinculo

- `contrato_id` e obrigatorio;
- cliente do recebimento deve ser igual ao destinatario da NFS-e;
- valor do recebimento deve ser exatamente igual ao valor do servico, comparado em centavos;
- formatos monetarios ambiguos ou com mais de duas casas sao rejeitados;
- emissao avulsa exige `idempotency_key` e o ID informado deve ser exatamente a NFS-e registrada no ledger;
- NFS-e so pode ser emitida a partir de `nfse_open` ou `emission_failed`.

## Recuperacao de falha parcial

Se o recebimento foi confirmado e a criacao da NFS-e falhou, uma nova execucao com o mesmo payload pula o recebimento ja registrado e tenta somente a NFS-e. O mesmo principio vale para falha confirmada de emissao. Nenhum cancelamento ou exclusao compensatoria e executado automaticamente.

Registros em estados `*_in_progress` apos reinicio sao considerados resultado incerto. O procedimento seguro e:

1. manter writes desligados para a chave afetada;
2. procurar o marcador no ERP por consultas read-only;
3. comparar cliente, competencia, valor e IDs;
4. atualizar o ledger somente por ferramenta administrativa auditada;
5. retomar apenas quando o estado final estiver comprovado.

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

Checkpoint desta fase: `backup/pre-rental-billing-v2-hardening-20260825`, apontando para `8c71e5389541424c0a761d260273c6200fdd2751`.

## Kill switch e rollback

Em incidente:

1. definir `RENTAL_BILLING_KILL_SWITCH=true`;
2. interromper agendamentos no n8n;
3. preservar e copiar o ledger antes de reiniciar ou trocar a versao;
4. listar e reconciliar todos os estados `*_in_progress`, `*_unknown`, `*_failed` e `nfse_open`;
5. voltar a imagem/commit anterior sem apagar o ledger;
6. reativar primeiro em modo read-only;
7. liberar criacao e emissao separadamente.

Rollback de software nao desfaz documentos financeiros ou fiscais ja aceitos pelo ERP. Exclusao, estorno ou cancelamento devem seguir procedimento financeiro/fiscal formal.
