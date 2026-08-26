import { randomUUID } from 'node:crypto';

export const ERROR_TAXONOMY = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DOWNSTREAM_REJECTED: 'DOWNSTREAM_REJECTED',
  WRITE_CONFIRMED_AFTER_ERROR: 'WRITE_CONFIRMED_AFTER_ERROR',
  WRITE_UNCERTAIN: 'WRITE_UNCERTAIN',
  DUPLICATE: 'DUPLICATE',
  AUTH_ERROR: 'AUTH_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  EVENTUAL_CONSISTENCY: 'EVENTUAL_CONSISTENCY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export const EFFECTIVE_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  SUCCESS_RECOVERED: 'SUCCESS_RECOVERED',
  FAILED: 'FAILED',
  WRITE_UNCERTAIN: 'WRITE_UNCERTAIN',
  DUPLICATE: 'DUPLICATE',
});

const SENSITIVE_KEY = /(authorization|token|secret|password|api[_-]?key|cookie)/i;

export function sanitizePayload(value, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizePayload(item, depth + 1);
  }
  return output;
}

export function correlationIdFrom(value) {
  const supplied = Array.isArray(value) ? value[0] : value;
  const normalized = String(supplied || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : randomUUID();
}

function normalizeEnumText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function resolveEnumOption(propertyName, suppliedValue, options = [], aliases = {}) {
  const supplied = normalizeEnumText(suppliedValue);
  const aliasValue = aliases?.[propertyName]?.[supplied];
  const wanted = normalizeEnumText(aliasValue || suppliedValue);
  const match = options.find((option) =>
    normalizeEnumText(option?.value) === wanted || normalizeEnumText(option?.label) === wanted,
  );
  if (!match?.value) {
    const error = new Error(`Invalid HubSpot enum value for ${propertyName}`);
    error.status = 400;
    error.taxonomy = ERROR_TAXONOMY.VALIDATION_ERROR;
    error.data = {
      field: propertyName,
      supplied_value: suppliedValue,
      allowed: options.filter((option) => option?.value).map((option) => ({ label: option.label, value: option.value })),
    };
    throw error;
  }
  return match.value;
}

export function classifyError(error) {
  const status = Number(error?.status || error?.http_status || 0);
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  if (status === 401 || status === 403) return ERROR_TAXONOMY.AUTH_ERROR;
  if (status === 429) return ERROR_TAXONOMY.RATE_LIMIT;
  if (status >= 400 && status < 500) return ERROR_TAXONOMY.DOWNSTREAM_REJECTED;
  if (!status && (name.includes('abort') || name.includes('timeout') || code.includes('timeout'))) {
    return ERROR_TAXONOMY.NETWORK_ERROR;
  }
  if (!status && error instanceof TypeError) return ERROR_TAXONOMY.NETWORK_ERROR;
  return status >= 500 ? ERROR_TAXONOMY.DOWNSTREAM_REJECTED : ERROR_TAXONOMY.INTERNAL_ERROR;
}

function downstreamEvidence(error, fallback) {
  return {
    http_status: Number(error?.status || error?.http_status || 0) || null,
    downstream_response: sanitizePayload(error?.data ?? error?.downstream_response ?? null),
    endpoint: error?.endpoint || fallback.endpoint,
    operation: error?.operation || fallback.operation,
    request_correlation_id: error?.correlation_id || fallback.correlationId,
    downstream_request_id: error?.request_id || null,
    sanitized_payload: sanitizePayload(error?.payload ?? fallback.payload),
    timestamp: error?.timestamp || new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error || 'downstream_write_failed'),
  };
}

function normalizeVerification(value) {
  const outcome = value?.outcome;
  if (outcome === 'found') {
    return {
      performed: true,
      outcome,
      found: true,
      equivalent: value.equivalent !== false,
      resource: sanitizePayload(value.resource ?? null),
      details: sanitizePayload(value.details ?? null),
    };
  }
  if (outcome === 'absent') {
    return {
      performed: true,
      outcome,
      found: false,
      equivalent: null,
      resource: null,
      details: sanitizePayload(value?.details ?? null),
    };
  }
  return {
    performed: true,
    outcome: 'inconclusive',
    found: null,
    equivalent: null,
    resource: null,
    details: sanitizePayload(value?.details ?? value ?? null),
  };
}

export function structuredLog(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...sanitizePayload(fields),
  }));
}

export async function reconcileWrite({
  operation,
  endpoint,
  correlationId,
  payload,
  write,
  verify,
  acceptDirectEvidence = false,
  directEvidence = (value) => Boolean(value),
}) {
  const timestamp = new Date().toISOString();
  let observation = null;
  let writeError = null;

  structuredLog('commercial_write_attempted', { operation, endpoint, correlation_id: correlationId });
  try {
    observation = await write();
  } catch (error) {
    writeError = error;
  }

  let verification;
  try {
    verification = normalizeVerification(await verify());
  } catch (error) {
    verification = normalizeVerification({
      outcome: 'inconclusive',
      details: downstreamEvidence(error, { operation: `${operation}_verification`, endpoint, correlationId, payload: null }),
    });
  }

  const directConfirmed = !writeError && acceptDirectEvidence && directEvidence(observation?.data);
  let effectiveStatus;
  let errorTaxonomy = null;

  if (writeError) {
    if (verification.found && verification.equivalent) {
      effectiveStatus = EFFECTIVE_STATUS.SUCCESS_RECOVERED;
      errorTaxonomy = ERROR_TAXONOMY.WRITE_CONFIRMED_AFTER_ERROR;
    } else if (verification.outcome === 'absent') {
      effectiveStatus = EFFECTIVE_STATUS.FAILED;
      errorTaxonomy = classifyError(writeError);
    } else {
      effectiveStatus = EFFECTIVE_STATUS.WRITE_UNCERTAIN;
      errorTaxonomy = ERROR_TAXONOMY.WRITE_UNCERTAIN;
    }
  } else if (verification.found && verification.equivalent) {
    effectiveStatus = EFFECTIVE_STATUS.SUCCESS;
  } else if (directConfirmed) {
    effectiveStatus = EFFECTIVE_STATUS.SUCCESS;
    if (verification.outcome !== 'found') errorTaxonomy = ERROR_TAXONOMY.EVENTUAL_CONSISTENCY;
  } else if (verification.outcome === 'absent') {
    effectiveStatus = EFFECTIVE_STATUS.FAILED;
    errorTaxonomy = ERROR_TAXONOMY.DOWNSTREAM_REJECTED;
  } else {
    effectiveStatus = EFFECTIVE_STATUS.WRITE_UNCERTAIN;
    errorTaxonomy = ERROR_TAXONOMY.WRITE_UNCERTAIN;
  }

  const failure = writeError
    ? downstreamEvidence(writeError, { operation, endpoint, correlationId, payload })
    : null;
  const result = {
    operation,
    write_attempted: true,
    http_status: writeError
      ? failure.http_status
      : Number(observation?.http_status || 0) || null,
    downstream_response: writeError
      ? failure.downstream_response
      : sanitizePayload(observation?.data ?? null),
    endpoint,
    request_correlation_id: correlationId,
    downstream_request_id: writeError ? failure.downstream_request_id : observation?.request_id ?? null,
    sanitized_payload: sanitizePayload(payload),
    timestamp,
    verification,
    effective_status: effectiveStatus,
    error_taxonomy: errorTaxonomy,
    ...(failure ? { downstream_error: failure } : {}),
  };

  structuredLog('commercial_write_reconciled', {
    operation,
    correlation_id: correlationId,
    effective_status: effectiveStatus,
    error_taxonomy: errorTaxonomy,
    verification_outcome: verification.outcome,
  });
  return result;
}
