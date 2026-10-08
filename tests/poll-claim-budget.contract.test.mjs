import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");

test("HTTP poll limits eligible claims before UPDATE, not HTTP response after claim", () => {
  const claim = source.slice(source.indexOf("WITH stale_candidates AS"), source.indexOf("RETURNING ${CLAIM_RETURNING}"));
  assert.match(claim, /ranked_claimable AS/);
  assert.match(claim, /bounded_claimable AS/);
  assert.match(claim, /SUM\(octet_length\(p\.payload::text\)/);
  assert.match(claim, /ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW/);
  assert.match(claim, /estimated_response_bytes <= \$\{MAX_POLL_RESPONSE_BYTES\}/);
  assert.match(claim, /FROM bounded_claimable\s+WHERE print_jobs\.id = bounded_claimable\.id/);
  assert.doesNotMatch(source, /const budgeted:|return NextResponse\.json\(budgeted\)/);
});

test("9 max-size payloads fit a 64 MiB poll; 10 do not", () => {
  const maxPayloadEncoded = Math.ceil(5 * 1024 * 1024 / 3) * 4;
  const maxResponse = 64 * 1024 * 1024;
  const perRow = maxPayloadEncoded + 2048;
  assert.ok(9 * perRow <= maxResponse);
  assert.ok(10 * perRow > maxResponse);
});
