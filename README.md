# Seta ERP Connector

Resilient write contract, compatibility, and rollback: [docs/RESILIENT_COMMERCIAL_WRITES.md](docs/RESILIENT_COMMERCIAL_WRITES.md).

Conector minimo para permitir que um GPT Action acesse o ERP Betel sem expor os tokens do ERP no schema OpenAPI.

## Variaveis de ambiente

- `BETEL_BASE_URL=https://api.beteltecnologia.com/api`
- `BETEL_ACCESS_TOKEN=token Betel`
- `BETEL_SECRET_ACCESS_TOKEN=secret Betel`
- `CONNECTOR_API_KEY=chave privada entre GPT Action e este conector`

## Rodar localmente

1. Instale Node.js 20+.
2. Rode `npm install`.
3. Configure as variaveis de ambiente.
4. Rode `npm start`.
5. Teste `GET http://localhost:3000/health`.

## Endpoints

- `GET /health`
- `GET /erp/clientes`
- `POST /erp/clientes`
- `GET /erp/produtos`
- `GET /erp/usuarios`
- `GET /erp/situacoes-orcamentos`
- `GET /erp/orcamentos`
- `GET /erp/orcamentos/:id`
- `POST /erp/orcamentos`

Todos os endpoints `/erp` exigem:

`Authorization: Bearer <CONNECTOR_API_KEY>`

## Deploy no Render

1. Crie um Web Service no Render apontando para este repositorio.
2. Use `npm install` como Build Command.
3. Use `npm start` como Start Command.
4. Configure as quatro variaveis de ambiente.
5. Depois do deploy, copie o dominio HTTPS.
6. Edite `openapi.yaml` e troque `https://SEU-DOMINIO-DO-CONECTOR` pelo dominio real.
7. No GPT Builder, crie uma Action e cole ou importe o schema OpenAPI.
8. Configure a autenticacao como Bearer e use o mesmo `CONNECTOR_API_KEY`.

## Seguranca

Nunca grave tokens da Betel ou a `CONNECTOR_API_KEY` no repositorio. Use somente variaveis de ambiente do provedor de hospedagem.
