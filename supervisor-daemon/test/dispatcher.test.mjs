import test from "node:test";
import assert from "node:assert/strict";
import { isDispatcherAuthorized, failureDisposition } from "../src/index.mjs";

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
