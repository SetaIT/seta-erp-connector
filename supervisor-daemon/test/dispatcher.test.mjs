import test from "node:test";
import assert from "node:assert/strict";
import { isDispatcherAuthorized, failureDisposition, isUuid, gestaoClickWritePolicy } from "../src/index.mjs";

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
    gestaoClickWritePolicy({ recurso: "produtos", acao: "deletar", confirmarEscrita: true, readOnly: false }),
    { allowed: false, reason: "resource_or_action_not_whitelisted" }
  );
});
