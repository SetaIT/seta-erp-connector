# Seta ERP Supervisor Daemon

Persistent 24x7 coordinator for ERP roadmap execution.

## Phase 2 dispatcher
- health + heartbeat
- ACTIVE / WAITING / IDLE state
- persistent task queue in PostgreSQL
- persistent event inbox
- atomic task claim
- run audit trail
- complete / retry / blocked transitions
- stale running-task recovery
- authenticated write endpoints
- no autonomous ERP/HubSpot/Outlook business writes

## Endpoints

Read-only:
- `GET /health`
- `GET /status`
- `GET /tasks`

Authenticated writes:
- `POST /tasks`
- `POST /events`
- `POST /tasks/:id/claim`
- `POST /tasks/:id/complete`
- `POST /tasks/:id/fail`

Authenticated endpoints accept the configured dispatcher token either as a raw header value or as `Bearer <token>`. Token/header values are never logged.

## State machine

```
pending -> running -> done
              |
              v
            fail
              |
      +-------+--------+
      |                |
   pending          blocked
  (retry)       (max retries)
```

## Runtime

Required:
- `DATABASE_URL`
- `DISPATCHER_TOKEN`

Optional:
- `SUPERVISOR_AUTONOMY_MODE=autonomous`
- `SUPERVISOR_HEARTBEAT_MS=30000`
- `SUPERVISOR_POLL_MS=15000`

The daemon remains cheap while idle. The n8n Supervisor claims tasks, delegates execution to specialist agents, then marks the task done or failed.
