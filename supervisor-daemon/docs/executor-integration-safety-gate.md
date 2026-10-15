# ERP Supervisor - executor integration safety gate

Status: **IMPLEMENTED IN PR #104; RUNTIME NOT CONNECTED** (2026-10-14).

## Verified evidence
- Railway production deployment `bd8609c9-0545-4eaf-8b04-742ac35e87bf`: SUCCESS.
- n8n seed execution `12206`: seven tasks ERP-201..ERP-207 created successfully.
- n8n observer execution `12208`: two done, seven pending.
- `supervisor-daemon/src/index.mjs` runs the dispatcher from the existing supervisor cycle when both QA executor settings are present.
- `supervisor-daemon/src/dispatcher.mjs` claims only explicitly approved, read-only `supervisor-qa` regression tasks; it records each dispatch in `supervisor_runs` and reconciles task-specific GitHub Actions evidence.
- GitHub Actions run correlation uses the workflow path, repository, `main` branch, `workflow_dispatch` event, task-bound display title and start time. It follows the REST API response shape (`.github/workflows/<file>@main`); workflow-run API responses do not expose dispatch inputs.
- Terminal failures, cancellations and expired or ambiguous dispatches are recorded as failed and blocked for human review. The dispatcher does not automatically resubmit an ambiguous dispatch.
- Destructive, financial, CRM-write and production-write tasks remain outside the allowed dispatcher scope.

## Runtime configuration required to activate
Configure these only after the PR is reviewed and merged:

| Railway service | Required variables |
| --- | --- |
| Supervisor daemon | `SUPERVISOR_QA_EXECUTOR_URL` (executor `/execute` URL), `SUPERVISOR_QA_EXECUTOR_TOKEN`, `GITHUB_TOKEN` with read access to Actions, plus existing `DATABASE_URL` |
| QA executor | `SUPERVISOR_QA_EXECUTOR_TOKEN` (same shared secret), `GITHUB_TOKEN` with permission to dispatch the `verified-erp-executor.yml` workflow |

Run the executor as a separate Railway service from the same repository using start command `node supervisor-daemon/src/qa-executor.mjs`; keep the daemon's existing start command. Do not configure production task writes as part of this QA-only activation.

## Required acceptance gates (before enabling an executor)
1. A real executor must have a configured, authenticated endpoint and explicit supported task types. No fabricated agent labels.
2. A single task is claimed atomically; record task ID, run ID, executor identity and evidence URL.
3. Execution outcome must be validated independently (tests, logs, changed files, deployment health) before calling `/tasks/:id/complete`.
4. On failure, record reason via `/tasks/:id/fail`; no silent success or unlimited retries.
5. Respect dependencies: ERP-202 after ERP-201; ERP-207 only after all earlier QA and promotion gates.
6. Writes to GestãoClick, HubSpot, Outlook, billing, or production deployments require their own authorization and safety checks. Read-only checks first.
7. Idempotent task creation: do not rerun seed workflow `nZTCDEgxWrliNJED` (POST /tasks currently creates a fresh UUID on each request).
8. Prove the worker in DEV with one disposable non-commercial smoke task, then verify database state, audit events and observed output. Promote only after tests pass.

## Roadmap evidence
| Task | Scope | Verified state |
| --- | --- | --- |
| ERP-201 | Vision / OmniRoute timeout | Pending; executor not connected |
| ERP-202 | Capture request E2E | Pending; dependent on ERP-201 |
| ERP-203 | Commercial proposal regression | Pending |
| ERP-204 | Rental billing | Pending; financial write prohibited |
| ERP-205 | Integration regression | Pending |
| ERP-206 | Rollback / promotion gate | Pending |
| ERP-207 | Production smoke | Pending; final gate |

Do not equate `autonomy_mode=autonomous` or a heartbeat with an active task executor. Runtime activation remains off until the required Railway settings are present and the health endpoint reports `executionCapability: approved-qa-only`.
