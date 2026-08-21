# Seta Proposal Service v2

Backend novo e limpo para o Agente de Propostas.

## Objetivos

- Node.js 20+ sem dependencia de provedor de hospedagem.
- Sem preloads, monkey patch ou proxy interno.
- Numero comercial e a interface publica para propostas existentes.
- ID interno do ERP fica restrito ao service.
- Escritas comerciais exigirao preview e confirmacao explicita.
- Testes unitarios primeiro; integracoes reais separadas.

## Estrutura

- `src/erp/betel-client.js`: transporte Betel.
- `src/services/proposals.js`: regras de consulta de propostas.
- `src/server.js`: HTTP minimo.
- `test/`: testes automaticos.

## Comandos

```bash
npm test
npm start
```

## Endpoints iniciais

- `GET /health`
- `GET /proposals/:numero`

A hospedagem sera escolhida somente depois de validar Betel, CRUD por numero e HubSpot.
