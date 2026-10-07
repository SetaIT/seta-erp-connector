import express from "express";
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const DISPATCHER_TOKEN = process.env.DISPATCHER_TOKEN || "";
const HEARTBEAT_MS = Number(process.env.SUPERVISOR_HEARTBEAT_MS || 30000);
const POLL_MS = Number(process.env.SUPERVISOR_POLL_MS || 15000);
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID || crypto.randomUUID();
const AUTONOMY_MODE = process.env.SUPERVISOR_AUTONOMY_MODE || "autonomous";
const GESTAOCLICK_MCP_URL = String(process.env.GESTAOCLICK_MCP_URL || "").trim();
const GESTAOCLICK_ACCESS_TOKEN = String(process.env.GESTAOCLICK_ACCESS_TOKEN || "").trim();
const GESTAOCLICK_SECRET_ACCESS_TOKEN = String(process.env.GESTAOCLICK_SECRET_ACCESS_TOKEN || "").trim();
const GESTAOCLICK_MCP_READ_ONLY = String(process.env.GESTAOCLICK_MCP_READ_ONLY || "true").toLowerCase() !== "false";
const GESTAOCLICK_MCP_MIN_INTERVAL_MS = Math.max(Number(process.env.GESTAOCLICK_MCP_MIN_INTERVAL_MS || 350), 334);
const GESTAOCLICK_MCP_DAILY_SOFT_LIMIT = Math.min(Number(process.env.GESTAOCLICK_MCP_DAILY_SOFT_LIMIT || 28000), 30000);
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

let gestaoclickMcpRateChain = Promise.resolve();
let gestaoclickMcpLastRequestAt = 0;

const app = express();
app.use(express.json({ limit: "1mb" }));

let lastHeartbeatAt = null;
let lastPollAt = null;
let lastError = null;
let loopRunning = false;

async function query(text, params = []) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool.query(text, params);
}

async function withTransaction(fn) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function isDispatcherAuthorized(headers, token = DISPATCHER_TOKEN) {
  if (!token) return false;
  const expectedBearer = `Bearer ${token}`;
  return Object.values(headers || {}).flatMap(value => Array.isArray(value) ? value : [value])
    .some(value => value === token || value === expectedBearer);
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function failureDisposition(retryCount, maxRetries) {
  const nextRetryCount = Number(retryCount || 0) + 1;
  const blocked = nextRetryCount >= Number(maxRetries || 0);
  return {
    retryCount: nextRetryCount,
    status: blocked ? "blocked" : "pending",
    requiresHuman: blocked
  };
}

function requireDispatcherAuth(req, res, next) {
  if (!DISPATCHER_TOKEN) {
    return res.status(503).json({ message: "dispatcher authentication is not configured" });
  }
  if (!isDispatcherAuthorized(req.headers)) {
    return res.status(401).json({ message: "unauthorized" });
  }
  next();
}

function gestaoclickMcpConfigured() {
  return Boolean(GESTAOCLICK_MCP_URL && GESTAOCLICK_ACCESS_TOKEN && GESTAOCLICK_SECRET_ACCESS_TOKEN);
}

function parseMcpPayload(contentType, raw) {
  if (!raw) return null;
  if (String(contentType || "").includes("text/event-stream")) {
    const payloads = String(raw)
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(Boolean);
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(payloads[index]); } catch {}
    }
    return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function reserveGestaoClickMcpRequestSlot() {
  const previous = gestaoclickMcpRateChain;
  let release;
  gestaoclickMcpRateChain = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const usage = await query(`
      INSERT INTO gestaoclick_mcp_usage(usage_date, request_count, updated_at)
      VALUES (CURRENT_DATE, 1, now())
      ON CONFLICT (usage_date) DO UPDATE
      SET request_count = gestaoclick_mcp_usage.request_count + 1,
          updated_at = now()
      RETURNING request_count
    `);
    const requestCount = Number(usage.rows[0]?.request_count || 0);
    if (requestCount > GESTAOCLICK_MCP_DAILY_SOFT_LIMIT) {
      await query(`
        UPDATE gestaoclick_mcp_usage
        SET request_count = GREATEST(request_count - 1, 0), updated_at = now()
        WHERE usage_date = CURRENT_DATE
      `);
      throw new Error(`GestaoClick MCP daily soft limit reached: ${GESTAOCLICK_MCP_DAILY_SOFT_LIMIT}`);
    }
    const waitMs = Math.max(0, GESTAOCLICK_MCP_MIN_INTERVAL_MS - (Date.now() - gestaoclickMcpLastRequestAt));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    gestaoclickMcpLastRequestAt = Date.now();
    return requestCount;
  } finally {
    release();
  }
}

async function gestaoclickMcpRequest(payload, sessionId = "") {
  if (!gestaoclickMcpConfigured()) throw new Error("GestaoClick MCP is not configured");
  await reserveGestaoClickMcpRequestSlot();
  const response = await fetch(GESTAOCLICK_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "access-token": GESTAOCLICK_ACCESS_TOKEN,
      "secret-access-token": GESTAOCLICK_SECRET_ACCESS_TOKEN,
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`GestaoClick MCP HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  return {
    body: parseMcpPayload(response.headers.get("content-type"), raw),
    sessionId: response.headers.get("mcp-session-id") || sessionId
  };
}

async function openGestaoClickMcpSession() {
  const initialized = await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "seta-erp-supervisor-daemon", version: "0.3.0" }
    }
  });
  const sessionId = initialized.sessionId;
  await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  }, sessionId);
  return { sessionId, initialize: initialized.body };
}

async function listGestaoClickMcpTools() {
  const session = await openGestaoClickMcpSession();
  const listed = await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/list",
    params: {}
  }, session.sessionId);
  const tools = listed.body?.result?.tools || [];
  return {
    protocolVersion: session.initialize?.result?.protocolVersion || null,
    serverInfo: session.initialize?.result?.serverInfo || null,
    count: tools.length,
    tools: tools.map(tool => ({
      name: tool?.name || "",
      description: tool?.description || "",
      inputSchema: tool?.inputSchema || null,
      annotations: tool?.annotations || null
    }))
  };
}

function safeReadOnlyTool(tool) {
  const name = String(tool?.name || "").toLowerCase();
  const description = String(tool?.description || "").toLowerCase();
  const annotations = tool?.annotations || {};
  const writePattern = /(criar|cadastrar|editar|alterar|atualizar|excluir|deletar|remover|cancelar|emitir|enviar|registrar|create|update|delete|remove|cancel|send|write|post|put|patch)/i;
  const readPattern = /(listar|consultar|buscar|visualizar|obter|pesquisar|list|get|read|search|find|lookup|query)/i;
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  if (writePattern.test(name) || writePattern.test(description)) return false;
  if (annotations.readOnlyHint === true && required.length === 0) return true;
  return required.length === 0 && (readPattern.test(name) || readPattern.test(description));
}

async function runGestaoClickReadOnlySmoke() {
  if (!GESTAOCLICK_MCP_READ_ONLY) throw new Error("GestaoClick MCP smoke requires read-only mode");
  const session = await openGestaoClickMcpSession();
  const listed = await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/list",
    params: {}
  }, session.sessionId);
  const tools = listed.body?.result?.tools || [];
  const selected = tools.find(safeReadOnlyTool);
  const summary = {
    protocolVersion: session.initialize?.result?.protocolVersion || null,
    serverName: session.initialize?.result?.serverInfo?.name || null,
    toolCount: tools.length,
    toolNames: tools.map(tool => tool.name),
    toolSchemas: tools.map(tool => ({
      name: tool?.name || "",
      required: Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [],
      properties: Object.keys(tool?.inputSchema?.properties || {})
    })),
    readOnlyCandidates: tools.filter(safeReadOnlyTool).map(tool => tool.name)
  };
  if (!selected) {
    console.log("gestaoclick-mcp-smoke", JSON.stringify({ ...summary, status: "discovery-ok-no-zero-arg-read-tool" }));
    return { ...summary, status: "discovery-ok-no-zero-arg-read-tool", selectedTool: null };
  }
  const called = await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: selected.name, arguments: {} }
  }, session.sessionId);
  const isError = Boolean(called.body?.result?.isError);
  const content = Array.isArray(called.body?.result?.content) ? called.body.result.content : [];
  if (isError) throw new Error(`GestaoClick MCP read smoke tool failed: ${selected.name}`);
  const result = {
    ...summary,
    status: "ok",
    selectedTool: selected.name,
    contentItems: content.length,
    contentTypes: [...new Set(content.map(item => item?.type).filter(Boolean))]
  };
  console.log("gestaoclick-mcp-smoke", JSON.stringify(result));
  return result;
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS supervisor_state (
      singleton boolean PRIMARY KEY DEFAULT true,
      mode text NOT NULL DEFAULT 'IDLE',
      autonomy_mode text NOT NULL DEFAULT 'autonomous',
      instance_id text,
      last_heartbeat_at timestamptz,
      last_poll_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS supervisor_tasks (
      id uuid PRIMARY KEY,
      project text NOT NULL,
      title text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'pending',
      priority integer NOT NULL DEFAULT 50,
      agent text,
      requires_human boolean NOT NULL DEFAULT false,
      retry_count integer NOT NULL DEFAULT 0,
      max_retries integer NOT NULL DEFAULT 5,
      blocked_reason text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS supervisor_tasks_runnable_idx
      ON supervisor_tasks (status, requires_human, priority DESC, created_at);

    CREATE TABLE IF NOT EXISTS supervisor_events (
      id uuid PRIMARY KEY,
      event_type text NOT NULL,
      project text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    );

    CREATE INDEX IF NOT EXISTS supervisor_events_pending_idx
      ON supervisor_events (status, created_at);

    CREATE TABLE IF NOT EXISTS supervisor_locks (
      resource text PRIMARY KEY,
      owner text NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS supervisor_runs (
      id uuid PRIMARY KEY,
      task_id uuid REFERENCES supervisor_tasks(id) ON DELETE SET NULL,
      agent text,
      status text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      result jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS gestaoclick_mcp_usage (
      usage_date date PRIMARY KEY,
      request_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function heartbeat() {
  const now = new Date();
  await query(`
    INSERT INTO supervisor_state(singleton, mode, autonomy_mode, instance_id, last_heartbeat_at, updated_at)
    VALUES (true, 'IDLE', $1, $2, $3, now())
    ON CONFLICT (singleton) DO UPDATE SET
      autonomy_mode = EXCLUDED.autonomy_mode,
      instance_id = EXCLUDED.instance_id,
      last_heartbeat_at = EXCLUDED.last_heartbeat_at,
      updated_at = now()
  `, [AUTONOMY_MODE, INSTANCE_ID, now]);
  lastHeartbeatAt = now.toISOString();
}

async function computeMode() {
  const { rows } = await query(`
    SELECT
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'pending' AND requires_human = false)::int AS runnable,
      count(*) FILTER (WHERE status IN ('pending','blocked') AND requires_human = true)::int AS waiting_human
    FROM supervisor_tasks
  `);
  const s = rows[0] || { running: 0, runnable: 0, waiting_human: 0 };
  if (s.running > 0 || s.runnable > 0) return "ACTIVE";
  if (s.waiting_human > 0) return "WAITING";
  return "IDLE";
}

async function supervisorCycle() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    const mode = await computeMode();
    const now = new Date();
    await query(`
      UPDATE supervisor_state
      SET mode=$1, last_poll_at=$2, updated_at=now()
      WHERE singleton=true
    `, [mode, now]);
    lastPollAt = now.toISOString();

    await query(`
      UPDATE supervisor_tasks
      SET status='pending',
          retry_count=retry_count+1,
          blocked_reason='Recovered stale running task after daemon restart',
          updated_at=now()
      WHERE status='running'
        AND updated_at < now() - interval '30 minutes'
        AND retry_count < max_retries
    `);

    await query(`
      UPDATE supervisor_tasks
      SET status='blocked',
          requires_human=true,
          blocked_reason=COALESCE(blocked_reason, 'Maximum retries reached'),
          updated_at=now()
      WHERE retry_count >= max_retries
        AND status IN ('pending','running')
    `);
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("supervisor-cycle-error", error);
  } finally {
    loopRunning = false;
  }
}

app.get("/health", async (_req, res) => {
  try {
    const db = await query("SELECT 1 AS ok");
    res.json({
      status:"ok",
      service:"seta-erp-supervisor-daemon",
      instanceId:INSTANCE_ID,
      autonomyMode:AUTONOMY_MODE,
      dispatcherAuth:DISPATCHER_TOKEN ? "configured" : "missing",
      gestaoclickMcp: gestaoclickMcpConfigured() ? "configured" : "missing",
      gestaoclickMcpMode: GESTAOCLICK_MCP_READ_ONLY ? "read-only" : "write-enabled",
      gestaoclickMcpMinIntervalMs: GESTAOCLICK_MCP_MIN_INTERVAL_MS,
      gestaoclickMcpDailySoftLimit: GESTAOCLICK_MCP_DAILY_SOFT_LIMIT,
      database:db.rows[0]?.ok === 1 ? "ok" : "unknown",
      lastHeartbeatAt,
      lastPollAt,
      lastError
    });
  } catch (error) {
    res.status(503).json({ status:"error", message:error instanceof Error ? error.message : String(error) });
  }
});

app.get("/mcp/gestaoclick/tools", requireDispatcherAuth, async (_req, res) => {
  try {
    const result = await listGestaoClickMcpTools();
    res.json({ status: "ok", mode: GESTAOCLICK_MCP_READ_ONLY ? "read-only" : "write-enabled", ...result });
  } catch (error) {
    res.status(502).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/status", async (_req, res) => {
  const [state, tasks, events] = await Promise.all([
    query("SELECT * FROM supervisor_state WHERE singleton=true"),
    query(`SELECT status, count(*)::int AS count FROM supervisor_tasks GROUP BY status ORDER BY status`),
    query(`SELECT status, count(*)::int AS count FROM supervisor_events GROUP BY status ORDER BY status`)
  ]);
  res.json({ state: state.rows[0] || null, tasks: tasks.rows, events: events.rows });
});

app.get("/tasks", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const { rows } = await query(`
    SELECT * FROM supervisor_tasks
    ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END,
      priority DESC,
      created_at ASC
    LIMIT $1
  `, [limit]);
  res.json({ items: rows });
});

app.post("/tasks", requireDispatcherAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.project || !body.title) return res.status(400).json({ message:"project and title are required" });
  const id = crypto.randomUUID();
  const { rows } = await query(`
    INSERT INTO supervisor_tasks
      (id, project, title, description, priority, agent, requires_human, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    RETURNING *
  `, [
    id,
    String(body.project),
    String(body.title),
    body.description ? String(body.description) : null,
    Number(body.priority || 50),
    body.agent ? String(body.agent) : null,
    Boolean(body.requiresHuman),
    JSON.stringify(body.payload || {})
  ]);
  res.status(201).json(rows[0]);
});

app.post("/events", requireDispatcherAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.type) return res.status(400).json({ message:"type is required" });
  const id = crypto.randomUUID();
  const { rows } = await query(`
    INSERT INTO supervisor_events(id,event_type,project,payload)
    VALUES ($1,$2,$3,$4::jsonb)
    RETURNING *
  `, [id, String(body.type), body.project ? String(body.project) : null, JSON.stringify(body.payload || {})]);
  res.status(202).json(rows[0]);
});

app.post("/tasks/:id/claim", requireDispatcherAuth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ message:"task id must be a UUID" });
  const agent = String(req.body?.agent || "supervisor-executivo");
  const runId = crypto.randomUUID();
  const result = await withTransaction(async client => {
    const taskResult = await client.query(`
      UPDATE supervisor_tasks
      SET status='running',
          agent=$2,
          blocked_reason=null,
          updated_at=now()
      WHERE id=$1 AND status='pending' AND requires_human=false
      RETURNING *
    `, [req.params.id, agent]);
    if (!taskResult.rows[0]) return null;
    const runResult = await client.query(`
      INSERT INTO supervisor_runs(id, task_id, agent, status)
      VALUES ($1,$2,$3,'running')
      RETURNING *
    `, [runId, req.params.id, agent]);
    return { task: taskResult.rows[0], run: runResult.rows[0] };
  });
  if (!result) return res.status(409).json({ message:"task is not claimable" });
  res.json(result);
});

app.post("/tasks/:id/complete", requireDispatcherAuth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ message:"task id must be a UUID" });
  const resultJson = req.body?.result && typeof req.body.result === "object"
    ? req.body.result
    : { message: String(req.body?.result || "completed") };
  const result = await withTransaction(async client => {
    const taskResult = await client.query(`
      UPDATE supervisor_tasks
      SET status='done',
          blocked_reason=null,
          updated_at=now()
      WHERE id=$1 AND status='running'
      RETURNING *
    `, [req.params.id]);
    if (!taskResult.rows[0]) return null;
    await client.query(`
      UPDATE supervisor_runs
      SET status='done',
          finished_at=now(),
          result=$2::jsonb
      WHERE id=(
        SELECT id FROM supervisor_runs
        WHERE task_id=$1 AND status='running'
        ORDER BY started_at DESC
        LIMIT 1
      )
    `, [req.params.id, JSON.stringify(resultJson)]);
    return taskResult.rows[0];
  });
  if (!result) return res.status(409).json({ message:"task is not running" });
  res.json(result);
});

app.post("/tasks/:id/fail", requireDispatcherAuth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ message:"task id must be a UUID" });
  const errorMessage = String(req.body?.error || "dispatcher execution failed");
  const result = await withTransaction(async client => {
    const current = await client.query(`
      SELECT * FROM supervisor_tasks
      WHERE id=$1 AND status='running'
      FOR UPDATE
    `, [req.params.id]);
    if (!current.rows[0]) return null;

    const disposition = failureDisposition(current.rows[0].retry_count, current.rows[0].max_retries);
    const blockedReason = disposition.requiresHuman ? errorMessage : null;
    const updated = await client.query(`
      UPDATE supervisor_tasks
      SET status=$2,
          retry_count=$3,
          requires_human=$4,
          blocked_reason=$5,
          updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [
      req.params.id,
      disposition.status,
      disposition.retryCount,
      disposition.requiresHuman,
      blockedReason
    ]);

    await client.query(`
      UPDATE supervisor_runs
      SET status='failed',
          finished_at=now(),
          result=$2::jsonb
      WHERE id=(
        SELECT id FROM supervisor_runs
        WHERE task_id=$1 AND status='running'
        ORDER BY started_at DESC
        LIMIT 1
      )
    `, [req.params.id, JSON.stringify({ error: errorMessage, retry: !disposition.requiresHuman })]);

    return updated.rows[0];
  });

  if (!result) return res.status(409).json({ message:"task is not running" });
  res.json(result);
});

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  await ensureSchema();
  await heartbeat();
  await supervisorCycle();
  if (gestaoclickMcpConfigured()) {
    try {
      await runGestaoClickReadOnlySmoke();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("gestaoclick-mcp-smoke-error", message);
      lastError = message;
    }
  }
  setInterval(() => heartbeat().catch(err => { lastError = err.message; console.error(err); }), HEARTBEAT_MS).unref();
  setInterval(() => supervisorCycle(), POLL_MS).unref();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ERP Supervisor Daemon listening on ${PORT}; instance=${INSTANCE_ID}; autonomy=${AUTONOMY_MODE}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  main().catch(error => {
    console.error("fatal", error);
    process.exit(1);
  });
}

export { app };
