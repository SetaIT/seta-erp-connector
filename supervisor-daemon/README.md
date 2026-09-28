# Seta ERP Supervisor Daemon

Persistent 24x7 coordinator for ERP roadmap execution.

## Phase 1
- health + heartbeat
- ACTIVE / WAITING / IDLE state
- persistent task queue in PostgreSQL
- persistent event inbox
- retry recovery for stale tasks
- locks/run tables for next execution phase
- no autonomous writes to ERP/HubSpot yet

## Endpoints
- `GET /health`
- `GET /status`
- `GET /tasks`
- `POST /tasks`
- `POST /events`
- `POST /tasks/:id/complete`

## Runtime
Required:
- `DATABASE_URL`

Optional:
- `SUPERVISOR_AUTONOMY_MODE=autonomous`
- `SUPERVISOR_HEARTBEAT_MS=30000`
- `SUPERVISOR_POLL_MS=15000`

The daemon is deliberately cheap while idle. AI agents are invoked only when work exists; agent execution is added in phase 2.
