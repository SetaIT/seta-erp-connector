import express from "express";
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const DISPATCHER_TOKEN = process.env.DISPATCHER_TOKEN || "";
const GESTAOCLICK_MCP_PROXY_TOKEN = process.env.GESTAOCLICK_MCP_PROXY_TOKEN || "";
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

export function gestaoClickWritePolicy({
  recurso,
  acao,
  confirmarEscrita,
  readOnly = GESTAOCLICK_MCP_READ_ONLY
} = {}) {
  const normalizedResource = String(recurso || "").trim().toLowerCase();
  const normalizedAction = String(acao || "").trim().toLowerCase();
  const allowed = {
    clientes: new Set(["cadastrar", "editar"]),
    orcamentos: new Set(["cadastrar", "editar", "deletar"]),
    produtos: new Set(["cadastrar"]),
    recebimentos: new Set(["cadastrar"])
  };
  if (readOnly) return { allowed: false, reason: "mcp_read_only" };
  if (confirmarEscrita !== true) return { allowed: false, reason: "explicit_confirmation_required" };
  if (!allowed[normalizedResource]?.has(normalizedAction)) {
    return { allowed: false, reason: "resource_or_action_not_whitelisted" };
  }
  return { allowed: true, reason: "allowed", recurso: normalizedResource, acao: normalizedAction };
}

export function gestaoClickWriteContract({ recurso, acao, dados = {}, id } = {}) {
  const normalizedResource = String(recurso || "").trim().toLowerCase();
  const normalizedAction = String(acao || "").trim().toLowerCase();
  const requiredByAction = {
    "clientes:cadastrar": ["tipo_pessoa", "nome"],
    "clientes:editar": ["tipo_pessoa", "nome"],
    "produtos:cadastrar": ["nome", "codigo_interno", "valor_custo"],
    "orcamentos:cadastrar": ["tipo", "codigo", "cliente_id", "situacao_id", "data"],
    "orcamentos:editar": ["tipo", "codigo", "cliente_id", "situacao_id", "data"],
    "orcamentos:deletar": [],
    "recebimentos:cadastrar": ["descricao", "data_vencimento", "plano_contas_id", "forma_pagamento_id", "conta_bancaria_id", "valor", "data_competencia"]
  };
  const key = `${normalizedResource}:${normalizedAction}`;
  const required = requiredByAction[key];
  if (!required) {
    return {
      valid: false,
      reason: "contract_not_defined",
      recurso: normalizedResource,
      acao: normalizedAction,
      required: [],
      missing: []
    };
  }
  const payload = dados && typeof dados === "object" && !Array.isArray(dados) ? dados : {};
  const missing = required.filter(field => {
    const value = payload[field];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
  if (["editar", "deletar"].includes(normalizedAction) && (id === undefined || id === null || String(id).trim() === "")) {
    missing.unshift("id");
  }
  return {
    valid: missing.length === 0,
    reason: missing.length ? "missing_required_fields" : "valid",
    recurso: normalizedResource,
    acao: normalizedAction,
    required,
    missing
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

function requireMcpProxyAuth(req, res, next) {
  const token = GESTAOCLICK_MCP_PROXY_TOKEN || DISPATCHER_TOKEN;
  if (!token) return res.status(503).json({ message: "MCP proxy authentication is not configured" });
  if (!isDispatcherAuthorized(req.headers, token)) return res.status(401).json({ message: "unauthorized" });
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


function parseGestaoClickMcpToolJson(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find(item => item?.type === "text")?.text;
  if (!text) throw new Error("GestaoClick MCP tool returned no text payload");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GestaoClick MCP tool returned invalid JSON payload");
  }
}

async function callGestaoClickApi({
  recurso,
  acao,
  id,
  dados = {},
  confirmarEscrita = false,
  sessionId = ""
}) {
  const session = sessionId ? { sessionId } : await openGestaoClickMcpSession();
  const called = await gestaoclickMcpRequest({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: {
      name: "chamar_api",
      arguments: {
        recurso,
        acao,
        ...(id !== undefined ? { id } : {}),
        dados,
        confirmar_escrita: confirmarEscrita
      }
    }
  }, session.sessionId);
  const result = called.body?.result || null;
  if (result?.isError) {
    const error = new Error(`GestaoClick MCP tool error: ${recurso}/${acao}`);
    error.result = result;
    throw error;
  }
  return { result, parsed: parseGestaoClickMcpToolJson(result), sessionId: called.sessionId || session.sessionId };
}

function unwrapGestaoClickApiEnvelope(parsed) {
  let value = parsed;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) break;
      try {
        value = JSON.parse(trimmed);
        continue;
      } catch {
        break;
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) break;
    if (value.resposta !== undefined) { value = value.resposta; continue; }
    if (value.response !== undefined) { value = value.response; continue; }
    if (value.result !== undefined && value.data === undefined) { value = value.result; continue; }
    break;
  }
  return value;
}

function safeResponseShape(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 20),
      status: value.status ?? null,
      code: value.code ?? null,
      dataType: Array.isArray(value.data) ? "array" : typeof value.data,
      dataLength: Array.isArray(value.data) ? value.data.length : null
    };
  }
  return { type: typeof value, preview: String(value ?? "").slice(0, 200) };
}

function extractInstallmentRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.dados)) return payload.dados;
  if (Array.isArray(payload.parcelas)) return payload.parcelas;
  return [];
}

async function calculateGestaoClickInstallments({
  valorTotal,
  formaPagamentoId,
  numeroParcelas,
  intervaloDias = 30,
  dataPrimeiraParcela,
  sessionId = ""
}) {
  const expectedCount = Number(numeroParcelas);
  const expectedTotal = Number(valorTotal);
  const dados = {
    valor_total: expectedTotal,
    forma_pagamento_id: Number(formaPagamentoId),
    numero_parcelas: expectedCount,
    intervalo_dias: Number(intervaloDias)
  };
  if (dataPrimeiraParcela) dados.data_primeira_parcela = String(dataPrimeiraParcela);

  const called = await callGestaoClickApi({
    recurso: "orcamentos",
    acao: "gerar_parcelas",
    dados,
    confirmarEscrita: false,
    sessionId
  });
  const upstreamStatus = Number(called.parsed?.http_status || 200);
  if (upstreamStatus >= 400) {
    const error = new Error(`GestaoClick installment calculator HTTP ${upstreamStatus}`);
    error.data = called.parsed;
    throw error;
  }

  const response = unwrapGestaoClickApiEnvelope(called.parsed);
  if (response?.status && String(response.status).toLowerCase() === "error") {
    const error = new Error("GestaoClick installment calculator returned error status");
    error.data = response;
    throw error;
  }

  const rows = extractInstallmentRows(response);
  const total = rows.reduce((sum, row) => {
    const item = row?.pagamento && typeof row.pagamento === "object" ? row.pagamento : row;
    return sum + Number(item?.valor || 0);
  }, 0);
  const roundedTotal = Number(total.toFixed(2));
  const roundedExpected = Number(expectedTotal.toFixed(2));

  if (rows.length !== expectedCount) {
    const error = new Error(`GestaoClick installment calculator returned ${rows.length} rows; expected ${expectedCount}`);
    error.data = { responseShape: safeResponseShape(response), rows: rows.length, expectedCount };
    throw error;
  }
  if (roundedTotal !== roundedExpected) {
    const error = new Error(`GestaoClick installment total ${roundedTotal} differs from expected ${roundedExpected}`);
    error.data = { response, roundedTotal, roundedExpected };
    throw error;
  }

  return {
    response,
    rows,
    total: roundedTotal,
    sessionId: called.sessionId
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

  const coreResources = [
    "clientes",
    "produtos",
    "situacoes_orcamentos",
    "formas_pagamentos",
    "orcamentos"
  ];
  const matrix = [];
  for (const recurso of coreResources) {
    try {
      const probe = await gestaoclickMcpRequest({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: "chamar_api",
          arguments: {
            recurso,
            acao: "listar",
            dados: { limite: 1 },
            confirmar_escrita: false
          }
        }
      }, session.sessionId);
      const probeResult = probe.body?.result || null;
      const probeContent = Array.isArray(probeResult?.content) ? probeResult.content : [];
      const preview = probeContent
        .filter(item => item?.type === "text")
        .map(item => String(item?.text || ""))
        .join("\n")
        .slice(0, 600);
      matrix.push({
        recurso,
        ok: !probeResult?.isError,
        contentItems: probeContent.length,
        preview
      });
    } catch (error) {
      matrix.push({ recurso, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log("gestaoclick-mcp-core-read-matrix", JSON.stringify(matrix));

  let installmentSmoke = { status: "skipped", reason: "payment_method_unavailable" };
  try {
    const paymentMethods = await callGestaoClickApi({
      recurso: "formas_pagamentos",
      acao: "listar",
      dados: { limite: 1 },
      confirmarEscrita: false,
      sessionId: session.sessionId
    });
    const paymentPayload = paymentMethods.parsed?.resposta ?? paymentMethods.parsed;
    const paymentRows = Array.isArray(paymentPayload?.data) ? paymentPayload.data : [];
    const firstPayment = paymentRows[0]?.FormasPagamento || paymentRows[0]?.forma_pagamento || paymentRows[0] || {};
    const paymentMethodId = firstPayment?.id;
    if (paymentMethodId) {
      const calculated = await calculateGestaoClickInstallments({
        valorTotal: 100,
        formaPagamentoId: paymentMethodId,
        numeroParcelas: 3,
        intervaloDias: 30,
        dataPrimeiraParcela: "2026-10-15",
        sessionId: session.sessionId
      });
      installmentSmoke = {
        status: "ok",
        paymentMethodId: String(paymentMethodId),
        installments: calculated.rows.length,
        total: calculated.total
      };
    }
  } catch (error) {
    installmentSmoke = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      responseShape: error?.data?.responseShape || null
    };
  }
  console.log("gestaoclick-mcp-installment-smoke", JSON.stringify(installmentSmoke));

  const describeTargets = ["clientes", "produtos", "orcamentos", "recebimentos"];
  const descriptions = [];
  for (const recurso of describeTargets) {
    try {
      const described = await gestaoclickMcpRequest({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: "describe_recurso",
          arguments: { recurso }
        }
      }, session.sessionId);
      const describeResult = described.body?.result || null;
      const describeContent = Array.isArray(describeResult?.content) ? describeResult.content : [];
      const preview = describeContent
        .filter(item => item?.type === "text")
        .map(item => String(item?.text || ""))
        .join("\n")
        .slice(0, 1800);
      descriptions.push({
        recurso,
        ok: !describeResult?.isError,
        contentItems: describeContent.length,
        preview
      });
    } catch (error) {
      descriptions.push({ recurso, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log("gestaoclick-mcp-resource-descriptions", JSON.stringify(descriptions));

  const actionTargets = [
    { recurso: "clientes", acao: "cadastrar" },
    { recurso: "clientes", acao: "editar" },
    { recurso: "produtos", acao: "cadastrar" },
    { recurso: "orcamentos", acao: "cadastrar" },
    { recurso: "orcamentos", acao: "editar" },
    { recurso: "orcamentos", acao: "deletar" },
    { recurso: "orcamentos", acao: "gerar_parcelas" },
    { recurso: "recebimentos", acao: "cadastrar" }
  ];
  const actionDescriptions = [];
  for (const target of actionTargets) {
    try {
      const described = await gestaoclickMcpRequest({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: "describe_recurso",
          arguments: target
        }
      }, session.sessionId);
      const describeResult = described.body?.result || null;
      const describeContent = Array.isArray(describeResult?.content) ? describeResult.content : [];
      const preview = describeContent
        .filter(item => item?.type === "text")
        .map(item => String(item?.text || ""))
        .join("\n")
        .slice(0, 3500);
      actionDescriptions.push({
        ...target,
        ok: !describeResult?.isError,
        contentItems: describeContent.length,
        preview
      });
    } catch (error) {
      actionDescriptions.push({
        ...target,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  console.log("gestaoclick-mcp-action-descriptions", JSON.stringify(actionDescriptions));
  return {
    ...result,
    coreReadMatrix: matrix,
    installmentSmoke,
    resourceDescriptions: descriptions,
    actionDescriptions
  };
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

    CREATE TABLE IF NOT EXISTS gestaoclick_mcp_audit (
      id uuid PRIMARY KEY,
      correlation_id text NOT NULL,
      recurso text NOT NULL,
      acao text NOT NULL,
      status text NOT NULL,
      request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS gestaoclick_mcp_audit_correlation_idx
      ON gestaoclick_mcp_audit (correlation_id, created_at DESC);
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

app.get("/mcp/gestaoclick/tools", requireMcpProxyAuth, async (_req, res) => {
  try {
    const result = await listGestaoClickMcpTools();
    res.json({ status: "ok", mode: GESTAOCLICK_MCP_READ_ONLY ? "read-only" : "write-enabled", ...result });
  } catch (error) {
    res.status(502).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/mcp/gestaoclick/read", requireMcpProxyAuth, async (req, res) => {
  try {
    if (!GESTAOCLICK_MCP_READ_ONLY) {
      return res.status(409).json({ status: "error", message: "GestaoClick MCP is not in read-only mode" });
    }
    const recurso = String(req.body?.recurso || "").trim();
    const acao = String(req.body?.acao || "listar").trim();
    const dados = req.body?.dados && typeof req.body.dados === "object" ? req.body.dados : {};
    const id = req.body?.id ?? undefined;
    if (!recurso) return res.status(400).json({ status: "error", message: "recurso is required" });
    if (!/^(listar|consultar|buscar|visualizar|obter|pesquisar|list|get|read|search|find|lookup|query)$/i.test(acao)) {
      return res.status(400).json({ status: "error", message: "acao is not allowed in read-only proxy" });
    }
    const session = await openGestaoClickMcpSession();
    const called = await gestaoclickMcpRequest({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "chamar_api",
        arguments: {
          recurso,
          acao,
          ...(id !== undefined ? { id } : {}),
          dados,
          confirmar_escrita: false
        }
      }
    }, session.sessionId);
    if (called.body?.result?.isError) {
      return res.status(502).json({ status: "error", result: called.body?.result || null });
    }
    res.json({ status: "ok", recurso, acao, result: called.body?.result || null });
  } catch (error) {
    res.status(502).json({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/mcp/gestaoclick/calculate-installments", requireMcpProxyAuth, async (req, res) => {
  const correlationId = String(req.headers["x-correlation-id"] || crypto.randomUUID());
  const valorTotal = Number(req.body?.valor_total);
  const formaPagamentoId = Number(req.body?.forma_pagamento_id);
  const numeroParcelas = Number(req.body?.numero_parcelas);
  const intervaloDias = req.body?.intervalo_dias === undefined ? 30 : Number(req.body.intervalo_dias);
  const dataPrimeiraParcela = req.body?.data_primeira_parcela ? String(req.body.data_primeira_parcela) : undefined;

  if (!Number.isFinite(valorTotal) || valorTotal < 0) {
    return res.status(400).json({ status: "error", correlationId, message: "valor_total must be a non-negative number" });
  }
  if (!Number.isInteger(formaPagamentoId) || formaPagamentoId <= 0) {
    return res.status(400).json({ status: "error", correlationId, message: "forma_pagamento_id must be a positive integer" });
  }
  if (!Number.isInteger(numeroParcelas) || numeroParcelas <= 0 || numeroParcelas > 120) {
    return res.status(400).json({ status: "error", correlationId, message: "numero_parcelas must be between 1 and 120" });
  }
  if (!Number.isInteger(intervaloDias) || intervaloDias < 0 || intervaloDias > 3650) {
    return res.status(400).json({ status: "error", correlationId, message: "intervalo_dias must be between 0 and 3650" });
  }
  if (dataPrimeiraParcela && !/^\d{4}-\d{2}-\d{2}$/.test(dataPrimeiraParcela)) {
    return res.status(400).json({ status: "error", correlationId, message: "data_primeira_parcela must use YYYY-MM-DD" });
  }

  try {
    const calculated = await calculateGestaoClickInstallments({
      valorTotal,
      formaPagamentoId,
      numeroParcelas,
      intervaloDias,
      dataPrimeiraParcela
    });
    return res.json({
      status: "ok",
      correlationId,
      source: "gestaoclick_mcp",
      operation: "orcamentos/gerar_parcelas",
      result: calculated.response
    });
  } catch (error) {
    return res.status(502).json({
      status: "error",
      correlationId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/mcp/gestaoclick/write-preview", requireDispatcherAuth, async (req, res) => {
  const recurso = String(req.body?.recurso || "").trim();
  const acao = String(req.body?.acao || "").trim();
  const dados = req.body?.dados && typeof req.body.dados === "object" ? req.body.dados : {};
  const id = req.body?.id ?? undefined;
  const policy = gestaoClickWritePolicy({
    recurso,
    acao,
    confirmarEscrita: true,
    readOnly: false
  });
  const contract = gestaoClickWriteContract({ recurso, acao, dados, id });
  return res.json({
    status: policy.allowed && contract.valid ? "ready" : "blocked",
    recurso: String(recurso || "").trim().toLowerCase(),
    acao: String(acao || "").trim().toLowerCase(),
    policy,
    contract,
    liveWriteEnabled: !GESTAOCLICK_MCP_READ_ONLY
  });
});

app.post("/mcp/gestaoclick/write", requireDispatcherAuth, async (req, res) => {
  const correlationId = String(req.headers["x-correlation-id"] || crypto.randomUUID());
  const recurso = String(req.body?.recurso || "").trim();
  const acao = String(req.body?.acao || "").trim();
  const dados = req.body?.dados && typeof req.body.dados === "object" ? req.body.dados : {};
  const id = req.body?.id ?? undefined;
  const policy = gestaoClickWritePolicy({
    recurso,
    acao,
    confirmarEscrita: req.body?.confirmar_escrita,
    readOnly: GESTAOCLICK_MCP_READ_ONLY
  });
  const contract = gestaoClickWriteContract({ recurso, acao, dados, id });
  if (!policy.allowed) {
    await query(`
      INSERT INTO gestaoclick_mcp_audit
        (id, correlation_id, recurso, acao, status, request_payload, response_summary)
      VALUES ($1,$2,$3,$4,'blocked',$5::jsonb,$6::jsonb)
    `, [
      crypto.randomUUID(),
      correlationId,
      recurso || "unknown",
      acao || "unknown",
      JSON.stringify({ id: id ?? null, dados, confirmar_escrita: req.body?.confirmar_escrita === true }),
      JSON.stringify({ reason: policy.reason })
    ]);
    return res.status(409).json({ status: "blocked", correlationId, reason: policy.reason });
  }
  if (!contract.valid) {
    await query(`
      INSERT INTO gestaoclick_mcp_audit
        (id, correlation_id, recurso, acao, status, request_payload, response_summary)
      VALUES ($1,$2,$3,$4,'blocked',$5::jsonb,$6::jsonb)
    `, [
      crypto.randomUUID(),
      correlationId,
      policy.recurso,
      policy.acao,
      JSON.stringify({ id: id ?? null, dados, confirmar_escrita: true }),
      JSON.stringify({ reason: contract.reason, missing: contract.missing, required: contract.required })
    ]);
    return res.status(422).json({
      status: "blocked",
      correlationId,
      reason: contract.reason,
      missing: contract.missing,
      required: contract.required
    });
  }

  try {
    const session = await openGestaoClickMcpSession();
    const called = await gestaoclickMcpRequest({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "chamar_api",
        arguments: {
          recurso: policy.recurso,
          acao: policy.acao,
          ...(id !== undefined ? { id } : {}),
          dados,
          confirmar_escrita: true
        }
      }
    }, session.sessionId);
    const result = called.body?.result || null;
    const ok = !result?.isError;
    await query(`
      INSERT INTO gestaoclick_mcp_audit
        (id, correlation_id, recurso, acao, status, request_payload, response_summary)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
    `, [
      crypto.randomUUID(),
      correlationId,
      policy.recurso,
      policy.acao,
      ok ? "success" : "error",
      JSON.stringify({ id: id ?? null, dados, confirmar_escrita: true }),
      JSON.stringify({ isError: Boolean(result?.isError), contentItems: Array.isArray(result?.content) ? result.content.length : 0 })
    ]);
    if (!ok) return res.status(502).json({ status: "error", correlationId, result });
    return res.json({ status: "ok", correlationId, recurso: policy.recurso, acao: policy.acao, result });
  } catch (error) {
    await query(`
      INSERT INTO gestaoclick_mcp_audit
        (id, correlation_id, recurso, acao, status, request_payload, response_summary)
      VALUES ($1,$2,$3,$4,'exception',$5::jsonb,$6::jsonb)
    `, [
      crypto.randomUUID(),
      correlationId,
      policy.recurso,
      policy.acao,
      JSON.stringify({ id: id ?? null, dados, confirmar_escrita: true }),
      JSON.stringify({ message: error instanceof Error ? error.message : String(error) })
    ]);
    return res.status(502).json({
      status: "error",
      correlationId,
      message: error instanceof Error ? error.message : String(error)
    });
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
