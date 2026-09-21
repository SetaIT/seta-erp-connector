# Auditoria técnica — seta-erp-connector

## Objetivo

Registrar dívida técnica que pode ser reduzida durante a estabilização V1 sem alterar o comportamento funcional já validado em produção.

## Situação atual

O processo de inicialização carrega várias camadas de preload antes de `gateway.js`:

- `environment-write-guard-preload.js`
- `deployment-diagnostics-preload.js`
- `action-probe-preload.js`
- `read-diagnostics-preload.js`
- `edit-diagnostics-preload.js`
- `number-write-preload.js`
- `clone-by-number-preload.js`
- `full-proposal-edit-preload.js`
- `services-read-preload.js`
- `product-write-preload.js`
- `read-resilient-preload.js`
- `hubspot-deal-normalization-preload.js`
- `hubspot-deal-delete-preload.js`

Além disso, `scripts/patch-email-branding.mjs` ainda altera o código em runtime antes da aplicação iniciar.

Essa arquitetura funcionou para corrigir problemas com baixo risco durante a evolução do projeto, mas aumenta a dificuldade de manutenção porque o comportamento efetivo da aplicação não está concentrado em uma única implementação.

## Riscos identificados

### 1. Ordem de preload

O resultado pode depender da ordem em que os módulos interceptam rotas, fetches ou objetos globais.

### 2. Duplicação de responsabilidade

Leitura, escrita, edição completa, clonagem e diagnósticos estão distribuídos em múltiplos arquivos. Isso aumenta o risco de duas camadas alterarem a mesma operação.

### 3. Código-fonte diferente do runtime

O patch de branding modifica o comportamento durante o start. O repositório pode não representar exatamente o código em execução.

### 4. Diagnóstico mais difícil

Uma falha em `gateway.js` pode ter sido introduzida ou mascarada por um preload anterior.

### 5. Regressão invisível

Adicionar um novo preload pode mudar uma rota existente sem que a alteração fique evidente no arquivo principal.

## Plano de consolidação

A consolidação deve ocorrer de forma incremental, sem uma reescrita completa.

### Fase A — Inventário

Para cada preload registrar:

- rotas interceptadas;
- funções substituídas;
- variáveis de ambiente usadas;
- motivo original da criação;
- testes que cobrem o comportamento;
- dependências de outros preloads.

### Fase B — Testes de contrato

Antes de mover qualquer lógica:

- garantir teste para leitura da proposta;
- garantir teste para edição parcial;
- garantir teste para edição completa;
- garantir teste para clonagem;
- garantir teste para produtos e serviços;
- garantir teste para reconciliação pós-write;
- garantir teste para HubSpot;
- garantir teste para bloqueio de escrita em DEV.

### Fase C — Incorporar correções estáveis

Mover gradualmente para módulos explícitos de domínio, por exemplo:

```text
src/
  erp/
    proposals-read.js
    proposals-write.js
    proposal-reconciliation.js
    products.js
    services.js
  crm/
    hubspot-deals.js
  email/
    outlook.js
  middleware/
    environment-write-guard.js
    diagnostics.js
```

Não mover mais de uma responsabilidade por alteração.

### Fase D — Remover preloads redundantes

Um preload só pode ser removido quando:

1. sua lógica estiver incorporada ao código principal/módulo de domínio;
2. os testes equivalentes estiverem passando;
3. a regressão no ambiente Developer estiver concluída;
4. não houver diferença observada no payload final.

## Prioridade recomendada

1. `scripts/patch-email-branding.mjs` — materializar branding no código-fonte.
2. `full-proposal-edit-preload.js` + lógica de edição já estabilizada.
3. `read-resilient-preload.js` e diagnósticos de leitura.
4. `product-write-preload.js` / `services-read-preload.js`.
5. preloads de HubSpot.
6. manter `environment-write-guard-preload.js` até existir middleware equivalente e testado.

## O que não deve ser feito durante a V1

- reescrever o conector inteiro;
- alterar simultaneamente ERP, HubSpot e Outlook;
- trocar contratos de API já usados pelo frontend;
- remover reconciliação pós-write;
- alterar regras comerciais enquanto se consolida infraestrutura.

## Critério de conclusão

A V1 não precisa eliminar todos os preloads. O objetivo é:

- eliminar patches que modificam fonte/runtime de forma transitória;
- documentar as responsabilidades restantes;
- garantir cobertura de testes;
- reduzir risco de mudanças futuras.
