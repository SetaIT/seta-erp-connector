# Roadmap ERP / Agente de Propostas

## Objetivo
Reduzir a participacao operacional do usuario no ciclo de desenvolvimento. O usuario informa o objetivo de negocio; o Gerente Tecnico transforma em especificacao, coordena implementacao, valida QA/deploy e retorna somente quando estiver pronto ou houver decisao humana indispensavel.

## Arquitetura alvo da fase atual

Usuario -> Gerente Tecnico ERP -> Desenvolvimento/Codex -> GitHub -> QA automatico -> Railway -> Smoke test -> aprovacao ou correcao

### Papel do Gerente Tecnico
- transformar pedido de negocio em criterios de aceite testaveis;
- conhecer arquitetura, regras comerciais e restricoes vigentes;
- criar/acompanhar tarefas tecnicas;
- exigir evidencias objetivas de testes e build;
- validar OpenAPI antes de chegar ao Builder;
- acompanhar deploy e distinguir falha de codigo de incidente externo;
- executar ou solicitar smoke tests de producao;
- reabrir correcao automaticamente quando QA falhar;
- escalar ao usuario apenas decisoes de negocio, credenciais, autorizacoes destrutivas ou bloqueios sem solucao tecnica segura.

## Estados padrao de uma tarefa
PLANEJADA -> EM DESENVOLVIMENTO -> CODE REVIEW -> QA -> DEPLOY -> SMOKE TEST -> APROVADA

Em caso de falha: FALHOU -> DIAGNOSTICO -> CORRECAO -> QA.

## Prioridades executivas atuais

A ordem de execucao passa a ser:

- **P0 - Estabilizar criacao e edicao de propostas em producao**, incluindo pagamentos, idempotencia e regressao;
- **P1 - Validar o MCP oficial do GestaoClick em producao no modo leitura**, com `initialize`, `tools/list` e chamada real somente leitura;
- **P2 - Implementar rate limit centralizado para acessos ao GestaoClick [CONCLUIDO]**, respeitando o limite oficial de 3 requisicoes por segundo e 30.000 por dia por empresa;
- **P3 - Consolidar MCP oficial do GestaoClick e iniciar MCP oficial do HubSpot**, mantendo escritas com whitelist, preview, confirmacao e auditoria;
- **P4 - Concluir CRUD de propostas exclusivamente por numero comercial para o usuario**;
- **P5 - Consolidar observabilidade, correlation ID, classificacao de incidentes e rollback validado**;
- **P6 - Avaliar reducao gradual do `seta-erp-connector` somente onde o MCP oficial cobrir a mesma operacao com seguranca equivalente**;
- **P7 - Reavaliar a migracao para Cloud Run apos estabilizacao funcional e operacional**.

O MCP oficial do GestaoClick e uma integracao direta do Supervisor Comercial. O `seta-erp-mcp` foi removido de producao apos migracao para o MCP oficial. O servico Railway `seta-erp-connector` tambem foi retirado do caminho ativo; `seta-comercial-api` permanece como camada comercial e de integracoes Seta enquanto as operacoes ERP sao migradas gradualmente para o MCP oficial.

## Fase 1 - QA automatico e disciplina de entrega [EM IMPLEMENTACAO]
- [x] comando `npm run qa`;
- [x] validacao JSON dos arquivos criticos;
- [x] validacao de sintaxe JS dos processos principais;
- [x] validacao de `operationId` unico;
- [x] limite de 300 caracteres para descriptions do Builder;
- [x] verificacao das operacoes obrigatorias do Agente de Propostas;
- [x] workflow GitHub Actions para push/PR;
- [x] runner de smoke test de producao;
- [x] validacao de identidade do commit implantado antes do smoke test;
- [x] configurar secrets/variables do smoke test no GitHub;
- [x] preflight de configuracao para falhar rapido quando secret/variable estiver ausente;
- [x] smoke manual autenticado validado com `production-verification` em sucesso;
- [ ] tornar QA check obrigatorio antes de merge na branch principal;
- [ ] ampliar testes de contrato para respostas do ERP/HubSpot.

## Fase 2 - Gerente Tecnico operacional [FUNCIONAL / EM EVOLUCAO]
- [x] padrao de issue/tarefa com objetivo, risco e criterios de aceite;
- [x] instrucoes permanentes do Gerente Tecnico;
- [x] rotina de triagem de falha: codigo vs configuracao vs terceiro;
- [x] review automatico deterministico de PR/diff;
- [x] bloqueio do workflow quando QA falhar;
- [x] relatorio padrao de decisao com risco e controles exigidos;
- [x] abrir incidente automaticamente quando QA/deploy smoke falhar;
- [x] integrar evidencias de deploy e smoke test ao ciclo de validacao do Gerente Tecnico;
- [x] validar o ciclo manual `preflight -> production-verification -> sucesso` sem gravacao comercial;
- [ ] fechar/reclassificar incidentes automaticamente apos recuperacao;
- [ ] emitir parecer final consolidado em PR/tarefa apos producao validada.

## Fase 3 - Observabilidade e deploy [EM IMPLEMENTACAO]
- [x] endpoint de identidade do deploy (`/deployment-info`);
- [x] smoke test de leitura ERP por numero comercial quando fixture estiver configurada;
- [x] smoke test HubSpot sem gravacao;
- [x] espera automatica pelo commit exato implantado antes do smoke;
- [x] criacao automatica de incidente quando validacao de producao falhar;
- [x] classificacao runtime vs non-runtime para evitar falsos incidentes de deploy;
- [ ] auditoria e logs estruturados por task/correlation ID;
- [ ] classificacao automatica aprofundada de incidentes Railway/upstream;
- [ ] rollback documentado e validado.

## Fase 4 - Estabilizacao do fluxo comercial [INICIADA]
Tarefa principal atual: Issue #5 - CRUD de propostas somente por numero comercial.

- [ ] CRUD de proposta totalmente pelo numero comercial para o usuario;
- [x] confirmacao segura para edicao/exclusao;
- [x] rota publica de DELETE por numero com resolucao interna do ID;
- [x] rota publica de PUT/edicao por numero com resolucao interna do ID;
- [x] OpenAPI sem exigir ID interno no fluxo recomendado;
- [x] regras de pagamento Locacao/SpareParts implementadas e testadas (a vista, 1 parcela, vencimento em 30 dias, parcela reconciliada com o total da proposta);
- [x] introducao comercial sugerida automaticamente a partir do tipo da proposta, solucao, prazo, frete, SLA e resumo dos itens; permanece editavel antes da gravacao e nunca preenche o campo formal de frete do ERP;
- [ ] enriquecer a introducao com contexto de cliente/oportunidade quando esse contexto estiver disponivel de forma confiavel via HubSpot MCP;
- [ ] fluxo Deal -> email -> Proposta Enviada -> follow-up -> Ganho/Perdido;
- [ ] testes de regressao das regras comerciais (regressao de pagamento Locacao/SpareParts adicionada; ampliar para introducao, frete, itens e ciclo completo).

## Fase 5 - Migracao de producao Railway -> Google Cloud Run
Executar somente apos a conclusao do QA automatico e a estabilizacao das operacoes CRUD de propostas.

Objetivos:
- [ ] preparar containerizacao padronizada da API Node.js/Express;
- [ ] configurar ambiente de producao no Google Cloud Run;
- [ ] migrar secrets e variaveis de ambiente com controle de acesso;
- [ ] integrar GitHub Actions ao pipeline de build/deploy;
- [ ] executar smoke tests automaticos apos cada deploy;
- [ ] validar logs, healthchecks e observabilidade no Google Cloud;
- [ ] documentar rollback para a versao anterior;
- [ ] executar migracao com plano de corte e retorno seguro;
- [ ] manter Railway temporariamente como homologacao/contingencia durante a transicao;
- [ ] apos estabilidade comprovada, definir Railway como homologacao ou descontinuar seu uso em producao.

Criterio de entrada desta fase:
- QA automatico obrigatorio e estavel;
- CRUD de propostas por numero comercial validado;
- testes de regressao criticos passando;
- fluxo de deploy atual documentado;
- smoke tests de producao confiaveis.

Arquitetura alvo apos a migracao:

ChatGPT / App MCP -> Google Cloud Run -> Betel ERP / HubSpot / Outlook

GitHub -> QA -> Build -> Deploy Cloud Run -> Smoke Test -> Aprovacao automatizada

## Fase 6 - MCP [ANTECIPADA / EM IMPLEMENTACAO]
A integracao MCP foi antecipada porque o GestaoClick passou a disponibilizar um MCP oficial. Nesta fase, o Supervisor Comercial se conecta diretamente ao MCP oficial em producao, inicialmente em modo leitura. Escritas permanecem bloqueadas ate existir whitelist, rate limit, auditoria e controles de confirmacao.

Arquitetura atual:

Supervisor Comercial
  -> MCP oficial GestaoClick -> ERP producao
  -> MCP oficial HubSpot -> CRM
  -> Outlook / Microsoft Graph -> email

O objetivo e usar os MCPs oficiais como caminho preferencial para operacoes nativas de cada plataforma, mantendo no codigo Seta apenas regras comerciais, orquestracao, auditoria, seguranca e fallbacks estritamente necessarios.

O App MCP Seta Telecom continua como superficie propria para regras e orquestracao que nao devem depender do provedor. Cloud Run deixa de ser pre-requisito para validar o MCP oficial e passa a ser uma decisao de infraestrutura posterior.

Controles obrigatorios:
- [x] credenciais do MCP oficial armazenadas no Railway de producao;
- [x] cliente MCP remoto no `erp-supervisor-daemon`;
- [x] modo `read-only` como padrao;
- [x] smoke E2E de leitura validado em producao (`initialize -> tools/list -> tools/call`, tool `listar_recursos`);
- [x] inventario inicial das 5 tools expostas pelo MCP oficial (`listar_recursos`, `describe_recurso`, `buscar_conhecimento`, `ler_conhecimento`, `chamar_api`);
- [x] rate limit centralizado com intervalo minimo e contador diario persistido;
- [x] proxy read-only protegido para `chamar_api`, com allowlist de acoes de leitura e `confirmar_escrita=false`;
- [x] cutover E2E `seta-comercial-api -> erp-supervisor-daemon -> MCP oficial -> GestaoClick` validado em producao para leitura (`clientes`, smoke HTTP 200);
- [x] politica/whitelist inicial de escrita implementada para `clientes` (`cadastrar`/`editar`), `orcamentos` (`cadastrar`/`editar`), `produtos` (`cadastrar`) e `recebimentos` (`cadastrar`), ainda bloqueada em producao enquanto `GESTAOCLICK_MCP_READ_ONLY=true`;
- [x] auditoria estruturada por correlation ID para escritas MCP em Postgres;
- [x] confirmacao explicita obrigatoria (`confirmar_escrita=true`) implementada na politica de escrita; ativacao de escrita real permanece pendente;
- [x] fallback de leitura para REST legado mantido no `seta-comercial-api` durante o cutover; rollback de escrita real continua antes da ativacao.
- [x] consulta de proposta por numero comercial preparada via MCP oficial com resolucao interna do ID e fallback de leitura;
- [x] caminho de edicao de proposta via MCP oficial implementado sob feature flag, ainda desabilitado em producao;
- [x] caminho de criacao de proposta via MCP oficial implementado sob feature flag, ainda desabilitado em producao;
- [x] resolucao pre/post-write por numero nas rotas de edicao/exclusao migrada para leituras MCP com fallback REST;
- [x] `describe_recurso` validado em producao para clientes, produtos, orcamentos e recebimentos;
- [x] contratos detalhados das acoes de escrita oficiais (`cadastrar`/`editar`) inventariados para clientes, produtos, orcamentos e recebimentos; campos obrigatorios agora sao validados antes de qualquer chamada de escrita;
- [x] endpoint de `write-preview` sem efeito colateral implementado para validar politica, contrato e prontidao do payload antes de habilitar escrita real;
- [x] operacao oficial `orcamentos/gerar_parcelas` descoberta e contrato validado (`valor_total`, `forma_pagamento_id`, `numero_parcelas`; opcionais `intervalo_dias` e `data_primeira_parcela`); o MCP classifica a chamada POST como escrita e exige `confirmar_escrita=true`, portanto o calculo local permanece ativo ate a fase controlada de escrita;
- [x] MCP oficial do HubSpot validado no contexto do conector ChatGPT, com leitura real de COMPANY;
- [x] disponibilidade MCP HubSpot confirmada com leitura e escrita para COMPANY, CONTACT, DEAL, LINE_ITEM, PRODUCT, TASK e NOTE;
- [x] smoke read-only HubSpot executado com sucesso em COMPANY pelo conector ChatGPT;
- [x] leitura de CONTACT associado a COMPANY validada via filtro de associacao do MCP HubSpot;
- [x] pipelines DEAL validados ao vivo via MCP HubSpot: `default/Vendas` e `9501279/Locacoes Servicos`; IDs de Aguardando Proposta, Proposta Enviada e Ganho conferem com `proposal-rules.json`;
- [x] propriedades DEAL customizadas `numero_da_proposta`, `link_da_proposta` e `solucao` confirmadas no schema MCP do portal;
- [ ] criar MCP Auth App do HubSpot e configurar o cliente remoto `https://mcp.hubspot.com` para o runtime Railway; somente depois disso migrar o trafego do `seta-comercial-api` para o MCP HubSpot em producao;
- [x] mapear rotas REST HubSpot existentes para equivalentes MCP oficiais:
  - `GET /erp/hubspot/empresas` -> `search_crm_objects` em COMPANY;
  - `GET /erp/hubspot/empresas/{id}/contatos` -> `search_crm_objects` em CONTACT com filtro de associacao COMPANY;
  - `GET /erp/hubspot/contatos` -> `search_crm_objects` em CONTACT;
  - `GET /erp/hubspot/negocios` -> `search_crm_objects` em DEAL usando `numero_da_proposta`;
  - criacao/edicao de empresa, contato e negocio -> `manage_crm_objects`;
  - associacoes empresa-contato-deal -> `manage_crm_objects` com associations;
  - notas/tarefas -> `manage_crm_objects` em NOTE/TASK;
- [ ] migrar primeiro pesquisas de empresa, contato, negocio e associacoes para MCP HubSpot;
- [ ] migrar criacao/edicao de COMPANY, CONTACT e DEAL para MCP HubSpot respeitando confirmacao explicita exigida pelo conector oficial;
- [ ] migrar associacoes empresa-contato-deal e registro de atividades/notas;
- [ ] manter REST customizado HubSpot apenas onde o MCP oficial nao oferecer cobertura equivalente ou onde houver regra Seta adicional;

Ferramentas alvo:
- consultar_proposta
- criar_proposta
- editar_proposta
- excluir_proposta
- buscar_cliente
- buscar_produto
- criar_deal
- preparar_email
- registrar_envio
- marcar_proposta_enviada
- marcar_ganho

## Participacao humana que permanece obrigatoria
- decisao de regra comercial;
- credenciais/conexoes novas;
- mudanca estrutural de alto impacto;
- gravacao comercial irreversivel;
- exclusao real em producao;
- envio real ao cliente;
- aprovacao de comportamento quando houver ambiguidade de negocio.

## Meta operacional
Reduzir o ciclo de uma mudanca comum para:
1. usuario informa objetivo;
2. Gerente Tecnico executa especificacao, desenvolvimento e validacao;
3. usuario recebe entrega pronta ou uma unica decisao objetiva para destravar.
