# Resilient commercial writes

## Diagnosis

`POST /erp/orcamentos` previously converted any non-2xx Betel response into a connector error before reconciliation. A proposal committed by Betel could therefore be reported as failed. The same status-first behavior affected Deal creation, and an empty HubSpot search during indexing could invite an unsafe retry.

The precise Betel server-side reason for “commit followed by HTTP 400” remains unknown because development intentionally performed no real writes. The next authorized execution will retain the original response body and request identifiers needed to diagnose it.

## Stable endpoints

No route was renamed or removed, including:

- `POST /erp/orcamentos`
- `GET /erp/orcamentos/numero/{numero}`
- `POST /erp/hubspot/negocios-da-proposta`
- existing read, edit, delete, email, and stage routes

## Write contract

Attempted proposal and Deal writes return a structured result:

```json
{
  "operation": "create_proposal",
  "write_attempted": true,
  "http_status": 400,
  "downstream_response": {},
  "verification": {
    "performed": true,
    "found": true,
    "equivalent": true
  },
  "effective_status": "SUCCESS_RECOVERED",
  "error_taxonomy": "WRITE_CONFIRMED_AFTER_ERROR",
  "endpoint": "/orcamentos",
  "request_correlation_id": "...",
  "downstream_request_id": "...",
  "sanitized_payload": {},
  "timestamp": "..."
}
```

The connector makes exactly one write attempt and verifies proposal number or Deal `numero_da_proposta`. `WRITE_UNCERTAIN` never triggers another write.

HubSpot solution labels are resolved against the property definition before create. `Locação de Switch` maps to internal value `Cisco`. Pipeline and initial stage are validated before company, contact, or Deal writes. The direct Deal response is primary evidence; subsequent search is confirmation only.

## Correlation and logging

`x-correlation-id` is accepted at the gateway, forwarded to the internal connector and downstream requests, returned as a response header, and included in structured JSON logs. Token, authorization, secret, password, cookie, and API-key fields are redacted.

## Compatibility

- Successful callers still receive HTTP 200 and existing business fields.
- Post-write rejection and uncertainty are represented by `effective_status` rather than inviting blind retry.
- Duplicate proposal/Deal guards return HTTP 200 with `effective_status=DUPLICATE`.
- Consumers continue only for `SUCCESS` or `SUCCESS_RECOVERED`.

## Rollback

The baseline is tagged `backup/pre-recoverable-commercial-flow-20260826-connector` at `10bba0c388ba6a29384d34378448c06494a400d2`. Redeploy that tag. No data migration is introduced.
