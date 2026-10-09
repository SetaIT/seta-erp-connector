import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
test("claim requires an executor run URL and stores it on run", () => {
  const a = source.indexOf('app.post("/tasks/:id/claim"');
  const b = source.indexOf('app.post("/tasks/:id/complete"', a);
  assert.ok(a >= 0 && b > a);
  const code = source.slice(a, b);
  assert.match(code, /executorRunUrl/);
  assert.match(code, /status\(422\)/);
  assert.match(code, /JSON\.stringify\(\{ executorRunUrl \}\)/);
  assert.match(code, /status='pending'/);
});
