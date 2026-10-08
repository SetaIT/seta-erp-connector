import test from "node:test";
import assert from "node:assert/strict";
import { isDispatcherAuthorized, failureDisposition, isUuid, gestaoClickWritePolicy, gestaoClickWriteContract } from "../src/index.mjs";

test("dispatcher auth rejects when token is missing", () => {
  assert.equal(isDispatcherAuthorized({ authorization: "Bearer abc" }, ""), false);
});

test("dispatcher auth accepts raw token in any header", () => {
  assert.equal(isDispatcherAuthorized({ "x-custom-auth": "secret" }, "secret"), true);
});

test("dispatcher auth accepts bearer token", () => {
  assert.equal(isDispatcherAuthorized({ authorization: "Bearer secret" }, "secret"), true);
});

test("dispatcher auth rejects invalid token", () => {
  assert.equal(isDispatcherAuthorized({ authorization: "Bearer wrong" }, "secret"), false);
});

test("failure retries while retry budget remains", () => {
  assert.deepEqual(failureDisposition(0, 5), {
    retryCount: 1,
    status: "pending",
    requiresHuman: false
  });
});

test("failure blocks when max retries reached", () => {
  assert.deepEqual(failureDisposition(4, 5), {
    retryCount: 5,
    status: "blocked",
    requiresHuman: true
  });
});


test("task id validation accepts UUIDs and rejects semantic slugs", () => {
  assert.equal(isUuid("d52f9c9a-7e89-4575-828d-24cc4c3af9b1"), true);
  assert.equal(isUuid("investigate-roadmap-status"), false);
  assert.equal(isUuid("dispenser-checkpoint"), false);
});


test("GestaoClick write policy blocks while MCP is read-only", () => {
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "orcamentos", acao: "editar", confirmarEscrita: true, readOnly: true }),
    { allowed: false, reason: "mcp_read_only" }
  );
});

test("GestaoClick write policy requires explicit confirmation", () => {
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "orcamentos", acao: "editar", confirmarEscrita: false, readOnly: false }),
    { allowed: false, reason: "explicit_confirmation_required" }
  );
});

test("GestaoClick write policy allowlists only approved writes", () => {
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "orcamentos", acao: "editar", confirmarEscrita: true, readOnly: false }),
    { allowed: true, reason: "allowed", recurso: "orcamentos", acao: "editar" }
  );
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "produtos", acao: "cadastrar", confirmarEscrita: true, readOnly: false }),
    { allowed: true, reason: "allowed", recurso: "produtos", acao: "cadastrar" }
  );
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "recebimentos", acao: "cadastrar", confirmarEscrita: true, readOnly: false }),
    { allowed: true, reason: "allowed", recurso: "recebimentos", acao: "cadastrar" }
  );
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "produtos", acao: "deletar", confirmarEscrita: true, readOnly: false }),
    { allowed: false, reason: "resource_or_action_not_whitelisted" }
  );
});


test("GestaoClick write contract validates proposal create required fields", () => {
  assert.deepEqual(
    gestaoClickWriteContract({
      recurso: "orcamentos",
      acao: "cadastrar",
      dados: { tipo: "1", codigo: "5000", cliente_id: "7", situacao_id: "3150", data: "2026-10-07" }
    }),
    {
      valid: true,
      reason: "valid",
      recurso: "orcamentos",
      acao: "cadastrar",
      required: ["tipo", "codigo", "cliente_id", "situacao_id", "data"],
      missing: []
    }
  );
});

test("GestaoClick write contract blocks incomplete proposal create", () => {
  const result = gestaoClickWriteContract({
    recurso: "orcamentos",
    acao: "cadastrar",
    dados: { cliente_id: "7", situacao_id: "3150" }
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_required_fields");
  assert.deepEqual(result.missing, ["tipo", "codigo", "data"]);
});

test("GestaoClick write contract requires id on edit", () => {
  const result = gestaoClickWriteContract({
    recurso: "clientes",
    acao: "editar",
    dados: { tipo_pessoa: "PJ", nome: "Empresa Teste" }
  });
  assert.equal(result.valid, false);
  assert.equal(result.missing[0], "id");
});

test("GestaoClick write contract validates receipt create required fields", () => {
  const result = gestaoClickWriteContract({
    recurso: "recebimentos",
    acao: "cadastrar",
    dados: {
      descricao: "Parcela proposta 5000",
      data_vencimento: "2026-11-06",
      plano_contas_id: "1",
      forma_pagamento_id: "2",
      conta_bancaria_id: "3",
      valor: "100.00",
      data_competencia: "2026-10-07"
    }
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});


test("GestaoClick write policy allows audited proposal delete", () => {
  assert.deepEqual(
    gestaoClickWritePolicy({ recurso: "orcamentos", acao: "deletar", confirmarEscrita: true, readOnly: false }),
    { allowed: true, reason: "allowed", recurso: "orcamentos", acao: "deletar" }
  );
});

test("GestaoClick write contract requires id on proposal delete", () => {
  const missingId = gestaoClickWriteContract({
    recurso: "orcamentos",
    acao: "deletar",
    dados: {}
  });
  assert.equal(missingId.valid, false);
  assert.deepEqual(missingId.missing, ["id"]);

  const ready = gestaoClickWriteContract({
    recurso: "orcamentos",
    acao: "deletar",
    id: "123",
    dados: {}
  });
  assert.equal(ready.valid, true);
  assert.deepEqual(ready.required, []);
  assert.deepEqual(ready.missing, []);
});
