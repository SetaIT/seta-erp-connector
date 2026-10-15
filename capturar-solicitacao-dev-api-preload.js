import express from 'express';
import { buildIntakeLookupPlan, normalizeCommercialIntake } from './capturar-solicitacao-core.js';
import { capturarSolicitacaoDevHtml } from './capturar-solicitacao-dev-ui.js';

const originalListen = express.application.listen;
let installed = false;

function enabled() {
  return String(process.env.DEV_MODE || '').toLowerCase() === 'true' &&
    String(process.env.CAPTURAR_SOLICITACAO_ENABLED || '').toLowerCase() === 'true' &&
    String(process.env.ALLOW_PRODUCTION_WRITES || '').toLowerCase() !== 'true';
}

express.application.listen = function patchedListen(...args) {
  if (!installed && enabled()) {
    installed = true;

    this.get('/dev/capturar-solicitacao', (req, res) => {
      res.type('html').status(200).send(capturarSolicitacaoDevHtml());
    });

    this.post('/dev/capturar-solicitacao/dry-run', (req, res) => {
      const intake = normalizeCommercialIntake(req.body || {});
      const lookupPlan = buildIntakeLookupPlan(intake);

      return res.status(200).json({
        mode: 'dry-run',
        writes_enabled: false,
        intake,
        lookup_plan: lookupPlan,
        next_action: intake.requer_revisao ? 'revisar_solicitacao' : 'buscar_empresa_read_only'
      });
    });
  }

  return originalListen.apply(this, args);
};
