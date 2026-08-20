import express from 'express';

const originalUse = express.application.use;
const originalGet = express.application.get;
let deploymentRouteInstalled = false;

function deploymentCommit() {
  return String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.COMMIT_SHA ||
    ''
  ).trim() || null;
}

function deploymentEnvironment() {
  if (process.env.RAILWAY_ENVIRONMENT_NAME) return process.env.RAILWAY_ENVIRONMENT_NAME;
  if (process.env.K_SERVICE) return 'google-cloud-run';
  return process.env.NODE_ENV || null;
}

function deploymentInfoHandler(req, res) {
  return res.status(200).json({
    status: 'ok',
    service: 'seta-erp-connector',
    deployment_commit: deploymentCommit(),
    deployment_environment: deploymentEnvironment(),
    railway_deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
    railway_service_name: process.env.RAILWAY_SERVICE_NAME || null,
    qa_runtime_probe: 'runtime-smoke-v1',
    generated_at: new Date().toISOString()
  });
}

express.application.use = function patchedDeploymentUse(...args) {
  const proxyFn = args.length === 1 && typeof args[0] === 'function' ? args[0] : null;
  if (!deploymentRouteInstalled && proxyFn?.name === 'proxyToLegacy') {
    deploymentRouteInstalled = true;
    originalGet.call(this, '/deployment-info', deploymentInfoHandler);
    console.log('Installed deployment info route before legacy proxy');
  }
  return originalUse.apply(this, args);
};
