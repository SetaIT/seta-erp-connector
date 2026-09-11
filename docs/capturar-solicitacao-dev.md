# Capturar Solicitação — ambiente DEV

Este documento define o ambiente canônico de desenvolvimento da funcionalidade Capturar Solicitação.

## Branch canônica

`capturar-solicitacao-dev`

Todo trabalho autônomo de desenvolvimento, QA e integração desta funcionalidade deve ocorrer nesta branch ou em branches temporárias derivadas dela. Não usar `main` nem branches conectadas a recursos de produção para trabalho em andamento.

## Railway canônico

Projeto: `seta-comercial-dev`

Serviço da aplicação: `capturar-solicitacao-app-dev`

Banco: `postgres-dev`

O nome do environment interno do Railway pode aparecer como `production` porque é o nome padrão criado dentro do projeto; isso não transforma o projeto DEV em produção.

## Barreiras de segurança

- `ALLOW_PRODUCTION_WRITES=false`
- `DEV_MODE=true`
- `APP_ENV=development`
- `ERP_WRITE_MODE=blocked`
- `HUBSPOT_WRITE_MODE=blocked`
- `EMAIL_SEND_MODE=blocked`
- carregamento obrigatório de `dev-write-guard-preload.js`
- POST/PUT/PATCH/DELETE externos bloqueados no runtime DEV
- GET/HEAD/OPTIONS externos permitidos para testes somente leitura
- comunicação interna entre serviços Railway permitida

## Gates antes de cada deploy DEV

Executar:

```text
npm test
npm run qa
```

Healthcheck: `GET /health`.

## Regra de promoção

DEV -> QA -> Pull Request -> revisão -> produção.

Nenhum agente DEV deve efetuar merge ou deploy em produção, nem habilitar gravação no ERP, HubSpot ou Microsoft Graph. Credenciais reais de escrita não devem ser copiadas para o ambiente DEV. Qualquer futura habilitação de sandbox deve usar credenciais próprias do sandbox.
