import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");

test("completion endpoint enforces verifiable HTTPS evidence", () => {
  const start = source.indexOf('app.post("/tasks/:id/complete"');
  const end = source.indexOf('app.post("/tasks/:id/fail"', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /Array\.isArray\(evidence\)/);
  assert.match(handler, /evidence\.length === 0/);
  assert.match(handler, /item\.type/);
  assert.match(handler, /item\.url/);
  assert.match(handler, /status\(422\)/);
  assert.match(handler, /resultJson = req\.body\.result/);
});
