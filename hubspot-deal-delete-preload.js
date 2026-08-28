import express from 'express';
import { sanitizePayload, structuredLog } from './commercial-write-reconciliation.js';

const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
const HUBSPOT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const useCounts = new WeakMap();
const registeredApps = new WeakSet();
const originalUse = express.application.use;
const originalDelete = express.application.delete;

function requestError(message, details = {}) {
  const err = new Error(message);
  err.status = 400;
  err.source = 'request';
  err.data = details;
  return err;
}

function auth(req, res, next) {
  if (!CONNECTOR_API_KEY) return res.status(503).json({ error: 'connector_not_configured', missing: ['CONNECTOR_API_KEY'] });
  if (req.headers.authorization !== `Bearer ${CONNECTOR_API_KEY}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function handleError(err, res, correlationId) {
  console.error(err);
  if (err?.status) {
    return res.status(err.status).json({
      error: `${err.source || 'request'}_error`,
      status: err.status,
      message: err.message,
      details: sanitizePayload(err.data),
      endpoint: err.endpoint || null,
      operation: err.operation || null,
      request_correlation_id: correlationId || err.correlation_id || null,
      downstream_request_id: err.request_id || null,
      timestamp: err.timestamp || new Date().toISOString(),
    });
  }
  return res.status(500).json({
    error: 'hubspot_deal_delete_error',
    message: err instanceof Error ? err.message : 'Erro desconhecido',
    request_correlation_id: correlationId || null,
    timestamp: new Date().toISOString(),
  });
}

async function hubspotRequest(path, { method = 'GET', body, correlationId, operation } = {}) {
  if (!HUBSPOT_ACCESS_TOKEN) {
    const err = new Error('HUBSPOT_ACCESS_TOKEN nao configurado');
    err.status = 503;
    err.source = 'hubspot';
    err.data = { missing: ['HUBSPOT_ACCESS_TOKEN'] };
    throw err;
  }

  const response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      Accept: 'application/json',
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  const requestId = response.headers.get('x-request-id')
    || response.headers.get('x-correlation-id')
    || response.headers.get('cf-ray');

  if (response.ok) {
    return { http_status: response.status, data, request_id: requestId };
  }

  const err = new Error(`HubSpot API error ${response.status}`);
  err.status = response.status;
  err.source = 'hubspot';
  err.data = data;
  err.endpoint = path;
  err.operation = operation || `${method.toLowerCase()}_hubspot`;
  err.correlation_id = correlationId;
  err.request_id = requestId;
  err.timestamp = new Date().toISOString();
  throw err;
}

export function validateHubSpotDealDeleteInput(dealId, body = {}) {
  const normalizedId = String(dealId || '').trim();
  if (!/^\d+$/.test(normalizedId)) {
    throw requestError('deal_id deve ser o ID interno numerico do HubSpot', {
      field: 'deal_id',
      note: 'Nunca use o numero comercial da proposta como deal_id.',
    });
  }
  if (body.confirmacao_exclusao !== true) {
    throw requestError('confirmacao_exclusao deve ser true para autorizar a exclusao irreversivel do Deal', {
      field: 'confirmacao_exclusao',
      required: true,
    });
  }
  const confirmationCode = String(body.codigo_confirmacao ?? '').trim();
  if (confirmationCode !== normalizedId) {
    throw requestError('codigo_confirmacao deve ser exatamente igual ao deal_id', {
      field: 'codigo_confirmacao',
      expected: normalizedId,
    });
  }
  return normalizedId;
}

export async function executeHubSpotDealDelete({
  dealId,
  body,
  correlationId,
  request = hubspotRequest,
}) {
  const normalizedId = validateHubSpotDealDeleteInput(dealId, body);
  const encodedId = encodeURIComponent(normalizedId);
  const properties = 'dealname,numero_da_proposta,pipeline,dealstage,amount';
  const previewPath = `/crm/v3/objects/deals/${encodedId}?properties=${properties}`;
  const deletePath = `/crm/v3/objects/deals/${encodedId}`;

  const previewResponse = await request(previewPath, {
    correlationId,
    operation: 'preview_hubspot_deal_delete',
  });
  const preview = previewResponse?.data ?? previewResponse;

  let deleteResponse = null;
  let deleteError = null;
  try {
    deleteResponse = await request(deletePath, {
      method: 'DELETE',
      correlationId,
      operation: 'delete_hubspot_deal',
    });
  } catch (error) {
    deleteError = error;
  }

  let verification;
  try {
    const verificationResponse = await request(previewPath, {
      correlationId,
      operation: 'verify_hubspot_deal_deleted',
    });
    verification = {
      outcome: 'still_exists',
      confirmed_absent: false,
      resource: sanitizePayload(verificationResponse?.data ?? verificationResponse),
    };
  } catch (error) {
    if (error?.status === 404) {
      verification = {
        outcome: 'absent',
        confirmed_absent: true,
        downstream_request_id: error.request_id || null,
      };
    } else {
      verification = {
        outcome: 'inconclusive',
        confirmed_absent: null,
        error: {
          message: error instanceof Error ? error.message : 'verification_failed',
          status: error?.status ?? null,
          details: sanitizePayload(error?.data ?? null),
        },
      };
    }
  }

  if (verification.outcome === 'absent') {
    return {
      httpStatus: 200,
      payload: {
        status: 'success',
        effective_status: deleteError ? 'SUCCESS_RECOVERED' : 'SUCCESS',
        deal_id: normalizedId,
        preview: sanitizePayload(preview),
        delete_evidence: {
          attempted: true,
          http_status: deleteResponse?.http_status ?? deleteError?.status ?? null,
          downstream_request_id: deleteResponse?.request_id ?? deleteError?.request_id ?? null,
          recovered_after_error: Boolean(deleteError),
          error: deleteError ? sanitizePayload({ message: deleteError.message, status: deleteError.status, details: deleteError.data }) : null,
        },
        verification,
        request_correlation_id: correlationId || null,
        timestamp: new Date().toISOString(),
        notes: ['Somente o Deal foi excluido. Empresa e contatos associados nao foram excluidos.'],
      },
    };
  }

  if (verification.outcome === 'still_exists') {
    const confirmedFailure = Boolean(deleteError);
    return {
      httpStatus: confirmedFailure ? 409 : 202,
      payload: {
        status: confirmedFailure ? 'failed' : 'partial_success',
        effective_status: confirmedFailure ? 'FAILED' : 'VERIFICATION_FAILED',
        deal_id: normalizedId,
        preview: sanitizePayload(preview),
        delete_evidence: {
          attempted: true,
          http_status: deleteResponse?.http_status ?? deleteError?.status ?? null,
          downstream_request_id: deleteResponse?.request_id ?? deleteError?.request_id ?? null,
          error: deleteError ? sanitizePayload({ message: deleteError.message, status: deleteError.status, details: deleteError.data }) : null,
        },
        verification,
        request_correlation_id: correlationId || null,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    httpStatus: 202,
    payload: {
      status: 'write_uncertain',
      effective_status: 'WRITE_UNCERTAIN',
      deal_id: normalizedId,
      preview: sanitizePayload(preview),
      delete_evidence: {
        attempted: true,
        http_status: deleteResponse?.http_status ?? deleteError?.status ?? null,
        downstream_request_id: deleteResponse?.request_id ?? deleteError?.request_id ?? null,
        error: deleteError ? sanitizePayload({ message: deleteError.message, status: deleteError.status, details: deleteError.data }) : null,
      },
      verification,
      request_correlation_id: correlationId || null,
      timestamp: new Date().toISOString(),
      note: 'Nao repetir a exclusao automaticamente. Fazer nova leitura antes de qualquer nova tentativa.',
    },
  };
}

function registerDeleteRoute(app) {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);

  originalDelete.call(
    app,
    '/erp/hubspot/negocios/:id',
    auth,
    async (req, res) => {
      const correlationId = req.correlationId || req.headers['x-correlation-id'] || null;
      try {
        const result = await executeHubSpotDealDelete({
          dealId: req.params.id,
          body: req.body || {},
          correlationId,
        });
        structuredLog('hubspot_deal_delete_completed', {
          correlation_id: correlationId,
          deal_id: String(req.params.id || ''),
          effective_status: result.payload?.effective_status || null,
        });
        return res.status(result.httpStatus).json(result.payload);
      } catch (error) {
        return handleError(error, res, correlationId);
      }
    },
  );
}

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  const count = (useCounts.get(this) || 0) + 1;
  useCounts.set(this, count);

  // gateway.js registers express.json() and correlation middleware as its first
  // two app.use() calls. Register immediately afterwards so the delete route
  // is parsed/traced and remains ahead of the final proxyToLegacy middleware.
  if (count === 2) registerDeleteRoute(this);
  return result;
};
