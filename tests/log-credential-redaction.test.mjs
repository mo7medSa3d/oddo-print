import assert from "node:assert/strict";
import test from "node:test";
import { logError, logInfo } from "../src/lib/log.ts";

function captureLog(callback) {
  const lines = [];
  const previousError = console.error;
  const previousInfo = console.info;
  console.error = (line) => lines.push(String(line));
  console.info = (line) => lines.push(String(line));
  try {
    callback();
  } finally {
    console.error = previousError;
    console.info = previousInfo;
  }
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("diagnostic fields do not disclose raw credentials from exception messages and stacks", () => {
  const secret = "synthetic-restore-password-9876";
  const exception = new Error(`connection refused for postgres://reader:${secret}@db.internal:5432/tenant`);
  const entry = captureLog(() => logError("db.connection_failed", {
    error: exception.message,
    exception,
    details: { message: `password=${secret}`, stack: `stack: ${secret}` },
    errorCategory: "connection",
    sqlState: "08006",
  }));

  assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret));
  assert.equal(entry.errorCategory, "connection");
  assert.equal(entry.sqlState, "08006");
});

test("credential-shaped text in incidental fields, URLs and event names is redacted", () => {
  const bearer = "SYNTHETIC_BEARER_4f2e98a9";
  const apiKey = "SYNTHETIC_API_KEY_1177";
  const token = "header.payload.syntheticsignature";
  const eventSecret = "synthetic-event-pass-771";
  const entry = captureLog(() => logInfo(`request https://svc:${eventSecret}@example.test`, {
    note: `Authorization: Bearer ${bearer}; api_key=${apiKey}`,
    endpoint: `https://user:${eventSecret}@example.test/submit?token=${token}`,
    status: "queued",
  }));

  const logged = JSON.stringify(entry);
  for (const value of [bearer, apiKey, token, eventSecret]) {
    assert.equal(logged.includes(value), false, `log includes credential ${value}`);
  }
  assert.equal(entry.status, "queued");
});

test("unstructured oversized messages cannot expose a secret through truncation", () => {
  const secret = "synthetic-long-message-secret-44";
  const entry = captureLog(() => logError("ws.failure", {
    error: `Bearer ${secret} ` + "a".repeat(700),
  }));
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret));
});
