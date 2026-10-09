import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
test("task claim cannot skip earlier tasks from same roadmap", () => {
  const a = source.indexOf('app.post("/tasks/:id/claim"');
  const b = source.indexOf('app.post("/tasks/:id/complete"', a);
  assert.ok(a >= 0 && b > a);
  const code = source.slice(a, b);
  assert.match(code, /NOT EXISTS/);
  assert.match(code, /earlier\.project = supervisor_tasks\.project/);
  assert.match(code, /parentTaskId/);
  assert.match(code, /earlier\.status <> 'done'/);
  assert.match(code, /status\(409\)/);
});
