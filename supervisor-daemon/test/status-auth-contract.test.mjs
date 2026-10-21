import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
function route(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "route markers must exist in the expected order");
  return source.slice(a, b);
}
test("Supervisor status requires authentication before state and event reads", () => {
  const block = route('app.get("/status"', 'app.get("/tasks"');
  assert.match(block, /^app\.get\("\/status", requireDispatcherAuth, async \(_req, res\) => \{/);
  assert.match(block, /supervisor_state/);
  assert.match(block, /supervisor_tasks/);
  assert.match(block, /supervisor_events/);
});
test("Supervisor tasks must be authenticated, including unauthorized access", () => {
  const block = route('app.get("/tasks"', 'app.post("/tasks"');
  assert.match(block, /^app\.get\("\/tasks", requireDispatcherAuth, async \(req, res\) => \{/);
});
test("Authorization gate fails closed when token absent or unauthorized", () => {
  const block = route("function requireDispatcherAuth", "function ",);
  assert.match(block, /if \(!DISPATCHER_TOKEN\)/);
  assert.match(block, /status\(503\)/);
  assert.match(block, /!isDispatcherAuthorized\(req\.headers\)/);
  assert.match(block, /status\(401\)/);
  assert.match(block, /next\(\)/);
});
test("Health remains available to infrastructure probes", () => {
  assert.match(source, /app\.get\("\/health",/);
});
