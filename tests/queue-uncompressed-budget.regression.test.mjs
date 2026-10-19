import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

const source = readFileSync("src/lib/print-job-service.ts", "utf8");

test("queued jobs use logical payload bytes rather than compressed storage bytes", () => {
  const query = source.slice(source.indexOf("const counts = await tx.execute(sql`"), source.indexOf("const row = counts.rows[0]"));
  assert.match(query, /SUM\(octet_length\(payload::text\)\)/);
  assert.doesNotMatch(query, /pg_column_size\(payload\)/);
});

test("storage compression does not bound wire payload size", () => {
  const data = "A".repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4);
  assert.ok(deflateRawSync(Buffer.from(data)).length < Buffer.byteLength(data) / 100);
});
