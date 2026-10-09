import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
test("claim SQL has valid template boundaries and parameter arrays", () => {
  const a = source.indexOf('app.post("/tasks/:id/claim"');
  const b = source.indexOf('app.post("/tasks/:id/complete"', a);
  assert.ok(a >= 0 && b > a);
  const block = source.slice(a, b);
  assert.match(block, /RETURNING \*\s*`\s*,\s*\[req\.params\.id, agent\]/);
  assert.match(block, /JSON\.stringify\(\{ executorRunUrl \}\)/);
  assert.match(block, /earlier\.status <> 'done'/);
});
