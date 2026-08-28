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
- [ ] confirmacao segura para edicao/exclusao;
- [ ] rota publica de DELETE por numero com resolucao interna do ID;
- [ ] rota publica de PUT/edicao por numero com resolucao interna do ID;
- [ ] OpenAPI sem exigir ID interno no fluxo recomendado;
- [ ] regras de pagamento Locacao/SpareParts;
- [ ] fluxo Deal -> email -> Proposta Enviada -> follow-up -> Ganho/Perdido;
- [ ] testes de regressao das regras comerciais.

### Assistente Comercial ponta a ponta

Arquitetura vigente: `Supervisor Comercial -> Betel ERP -> HubSpot -> Outlook -> log no HubSpot`. GestaoClick nao integra este processo.

- [x] conexoes Betel, HubSpot e Outlook validadas;
- [x] criacao de proposta com verificacao posterior;
- [x] criacao de Deal com bloqueio de duplicidade;
- [x] modelos adaptaveis para nova proposta, proposta revisada e follow-up;
- [x] aprovacao unica do pacote proposta + Deal + email;
- [x] Outlook message ID obrigatorio no registro HubSpot;
- [x] deteccao de registro repetido por Outlook message ID associado ao Deal;
- [ ] teste real controlado do pacote completo;
- [ ] reconciliacao automatica de `email_sent_log_pending`;
- [ ] PDF da proposta como anexo opcional, mantendo o link Betel como referencia primaria.

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

## Fase 6 - MCP [PROXIMA EVOLUCAO]
Depois da estabilizacao da arquitetura atual e da migracao de producao para Cloud Run, migrar a superficie de ferramentas para um App MCP Seta Telecom, mantendo a camada de regras e orquestracao desacoplada do provedor de infraestrutura.

ChatGPT -> App MCP Seta Telecom -> Cloud Run -> Betel ERP / HubSpot / Outlook

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
