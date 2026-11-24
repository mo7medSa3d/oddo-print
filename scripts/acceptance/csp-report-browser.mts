/**
 * Real browser acceptance for the production CSP generator, request guard and
 * collector. Requires a local Playwright installation and Chromium executable:
 * YASEIR_PLAYWRIGHT_MODULE=/abs/playwright/index.mjs
 * YASEIR_CHROMIUM_EXECUTABLE=/abs/chrome
 * node --import tsx scripts/acceptance/csp-report-browser.mts
 *
 * Uses only an ephemeral loopback HTTP server and synthetic cookie/query data.
 * The test browser disables its sandbox because the acceptance host is already
 * isolated; this is not a deployment recommendation or a browser-hardening gate.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { POST } from "../../src/app/api/security/csp-report/route";
import { createRequestContentSecurityPolicy } from "../../src/server/content-security-policy";
import { guardApiRequest } from "../../src/server/request-guard";

const playwrightModule = process.env.YASEIR_PLAYWRIGHT_MODULE;
const executablePath = process.env.YASEIR_CHROMIUM_EXECUTABLE;
assert(playwrightModule && executablePath, "Set both local browser tool paths");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const messages: string[] = [];
const originalInfo = console.info;
console.info = (message: string) => { messages.push(message); };
const sourceSentinel = "synthetic-private-document-query";
const cookieSentinel = "synthetic-ambient-session";
let origin = "";
let reportCount = 0;
let acceptedBrowserReport: { status: number; cookie_present: boolean; fetch_site: string | undefined; matching_origin: boolean; declared_length: boolean } | undefined;
let resolveReport: () => void;
const browserReport = new Promise<void>((resolve) => { resolveReport = resolve; });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/security/csp-report" && req.method === "POST") {
      const guarded = await guardApiRequest(req, res);
      if (!guarded) return;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const init: RequestInit & { duplex: "half" } = {
        method: "POST", headers, body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half",
      };
      const response = await POST(new Request(`${origin}/api/security/csp-report`, init));
      reportCount += 1;
      acceptedBrowserReport = {
        status: response.status, cookie_present: req.headers.cookie?.includes("mgr_session=") === true,
        fetch_site: req.headers["sec-fetch-site"] as string | undefined,
        matching_origin: req.headers.origin === origin, declared_length: typeof req.headers["content-length"] === "string",
      };
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end();
      resolveReport();
      return;
    }
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const { nonce, policy } = createRequestContentSecurityPolicy();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy,
      "Set-Cookie": `mgr_session=${cookieSentinel}; Path=/; HttpOnly; SameSite=Strict`,
    });
    res.end(`<!doctype html><title>CSP acceptance</title><script nonce="${nonce}">window.__cspAllowed = true</script><script>window.__cspUnsafeRan = true</script>`);
  } catch {
    res.writeHead(500); res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
origin = `http://127.0.0.1:${address.port}`;
process.env.APP_BASE_URL = origin;
process.env.NODE_ENV = "production";
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  const page = await browser.newPage();
  await page.goto(`${origin}/?token=${sourceSentinel}`);
  await page.waitForFunction(() => (window as Window & { __cspAllowed?: boolean }).__cspAllowed === true);
  assert.equal(await page.evaluate(() => (window as Window & { __cspUnsafeRan?: boolean }).__cspUnsafeRan), undefined);
  await Promise.race([browserReport, new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("Browser report was not delivered within 10 seconds")), 10_000);
  })]);
  if (deadline) clearTimeout(deadline);
  assert.equal(reportCount, 1);
  assert.equal(acceptedBrowserReport?.status, 204);
  assert.equal(acceptedBrowserReport?.cookie_present, true);
  assert.equal(acceptedBrowserReport?.declared_length, true);
  assert.equal(messages.length, 1);
  const telemetry = JSON.parse(messages[0]);
  assert.deepEqual(Object.keys(telemetry).sort(), ["directive", "disposition", "event", "status", "ts"]);
  assert.equal(telemetry.directive, "script-src-elem");
  assert.equal(telemetry.disposition, "enforce");
  assert.equal(telemetry.event, "security.csp_violation");
  assert(!messages[0].includes(sourceSentinel));
  assert(!messages[0].includes(cookieSentinel));

  const body = JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", disposition: "enforce", "status-code": 200 } });
  const forbidden = await fetch(`${origin}/api/security/csp-report`, {
    method: "POST", body, headers: { "Content-Type": "application/csp-report", cookie: `mgr_session=${cookieSentinel}`,
      origin: "https://other.example.test", "sec-fetch-site": "cross-site" },
  });
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  const noOrigin = await fetch(`${origin}/api/security/csp-report`, {
    method: "POST", body, headers: { "Content-Type": "application/csp-report", cookie: `mgr_session=${cookieSentinel}` },
  });
  assert.equal(noOrigin.status, 403);
  await noOrigin.text();
  assert.equal(messages.length, 1);
  originalInfo(JSON.stringify({
    success: true, browser_version: browser.version(), report_count: reportCount,
    browser_report: acceptedBrowserReport, inline_script_blocked: true, nonced_script_executed: true,
    caller_and_source_data_absent_from_log: true, cross_origin_cookie_status: forbidden.status,
    missing_origin_cookie_status: noOrigin.status, csrf_exemption_added: false,
    scope: "Real Chromium, loopback HTTP, production CSP/guard/collector; not deployed TLS or browser fleet certification",
  }, null, 2));
} finally {
  if (deadline) clearTimeout(deadline);
  console.info = originalInfo;
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
