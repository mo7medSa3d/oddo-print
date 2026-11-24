import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const runtime = dockerfile.split(/^FROM\s+.*\s+AS\s+runtime\s*$/im)[1];
assert(runtime, "the final runtime stage must be identifiable");
const healthchecks = runtime.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/).filter(line => /^HEALTHCHECK\b/i.test(line));

test("Gateway runtime contains exactly one effective healthcheck", () => {
  assert.equal(healthchecks.length, 1, "Docker silently overrides earlier HEALTHCHECK directives; retain one bounded probe");
});

async function exercise(status) {
  // Docker uses the last directive. Execute its actual Node program, changing
  // only the loopback port so this regression cannot contact a running app.
  const effective = healthchecks.at(-1);
  const program = effective?.match(/\bCMD node -e "([^"]+)"\s*$/)?.[1];
  assert(program, "the effective runtime check must use the bundled Node binary");
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (status !== null) { response.writeHead(status); response.end("synthetic-health-peer"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/health`;
    const source = program.replace("http://127.0.0.1:3000/api/health", endpoint);
    assert.notEqual(source, program, "the extracted probe must target the fixed readiness path");
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", source], { env: { PATH: process.env.PATH }, stdio: "ignore" });
      const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Runtime healthcheck exceeded its bounded deadline")); }, 7000);
      child.once("error", error => { clearTimeout(deadline); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, milliseconds: performance.now() - started }); });
    });
    assert.deepEqual(requests, ["/api/health"]);
    assert.equal(result.signal, null, "the check must exit itself rather than require forced termination");
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test("effective image healthcheck accepts an actual HTTP200 response", async () => {
  assert.equal((await exercise(200)).code, 0);
});

test("effective image healthcheck fails an actual HTTP503 response", async () => {
  assert.equal((await exercise(503)).code, 1);
});

test("effective image healthcheck times out an unresponsive HTTP service", { timeout: 10000 }, async () => {
  const result = await exercise(null);
  assert.equal(result.code, 1);
  assert(result.milliseconds >= 3500 && result.milliseconds < 6500, "the actual four-second abort must bound the probe");
});
