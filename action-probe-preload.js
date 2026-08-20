import express from 'express';

const originalUse = express.application.use;
const originalGet = express.application.get;
let installed = false;

express.application.use = function patchedActionProbeUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!installed && proxyFn?.name === 'proxyToLegacy') {
    installed = true;
    originalGet.call(this, '/action-probe', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        probe: 'action-to-railway',
        service: 'seta-erp-connector'
      });
    });
    console.log('Installed action-to-railway probe route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
