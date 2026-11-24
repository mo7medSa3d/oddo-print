import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

test("cloud print queue service is retired while wire payload contract keeps 5 MiB ceiling", () => {
  assert.equal(existsSync("src/lib/print-job-service.ts"), false);
  const contract = JSON.parse(readFileSync("contracts/print-payload-contract.json", "utf8"));
  assert.equal(contract.maxPayloadBytes, 5 * 1024 * 1024);
  const schema = readFileSync("src/db/schema.ts", "utf8");
  assert.doesNotMatch(schema, /pgTable\("print_jobs"/);
});

test("storage compression does not bound wire payload size", () => {
  const data = "A".repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4);
  assert.ok(deflateRawSync(Buffer.from(data)).length < Buffer.byteLength(data) / 100);
});
