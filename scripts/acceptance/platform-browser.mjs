#!/usr/bin/env node
/** Production-build browser acceptance, synthetic database and password sessions.
 * Run: node --import tsx scripts/acceptance/platform-browser.mjs OUTPUT_DIRECTORY
 * Requires DATABASE_URL for a disposable CREATEDB role, OpenSSL, Playwright,
 * and CHROMIUM_EXECUTABLE. PLAYWRIGHT_MODULE may select a separately pinned tool.
 * No external account, live email delivery, or public TLS is exercised.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import pg from "pg";
import { workspaceBrowserAcceptance } from "./workspace-browser.mjs";

const root = process.env.YASEIR_BROWSER_ROOT ? path.resolve(process.env.YASEIR_BROWSER_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.argv[2] || "");
if (!process.argv[2] || fs.existsSync(output)) throw new Error("A new output directory is required");
if (!process.env.DATABASE_URL || !process.env.CHROMIUM_EXECUTABLE) throw new Error("DATABASE_URL and CHROMIUM_EXECUTABLE are required");
// This acceptance fixture creates/drops a database and must never connect to
// an externally hosted cluster, even when given a valid CREATEDB credential.
const bootstrapDatabase = new URL(process.env.DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(bootstrapDatabase.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(bootstrapDatabase.hostname)) {
  throw new Error("Browser acceptance requires a dedicated loopback PostgreSQL cluster");
}
if (!fs.existsSync(path.join(root, ".next/BUILD_ID"))) throw new Error("Build the release before browser acceptance");
fs.mkdirSync(output, { recursive: true });
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaseir-browser-"));
fs.chmodSync(privateDir, 0o700);
const database = `yaseir_browser_${randomBytes(8).toString("hex")}`;
const connection = new URL(bootstrapDatabase); connection.pathname = `/${database}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: "-c timezone=UTC" });
const db = new pg.Pool({ connectionString: connection.href, max: 2, options: "-c timezone=UTC" });
const password = randomBytes(32).toString("base64url");
const jwt = randomBytes(48).toString("hex"), proxyKey = randomBytes(32).toString("hex");
const sensitive = [password, jwt, proxyKey];
const redact = text => sensitive.reduce((value, secret) => secret.length >= 6 ? value.replaceAll(secret, "[REDACTED]") : value, String(text));
const result = { status: "FAIL", startedAt: new Date().toISOString(), source: {
  revision: fs.existsSync(path.join(root,".git")) ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() : null,
  root,
  buildId: fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8").trim(),
}, environment: { node: process.version, playwright: "recorded at runtime", browser: "recorded at runtime" }, checks: [],
limitations: ["Browser trusts only an ephemeral loopback certificate SPKI pin; not public PKI or deployed staging acceptance", "Synthetic database and accounts only; HIBP and Resend transport fixtures verify application timing/lifecycle, not live provider delivery"] };
const appFiles = fs.readdirSync(path.join(root,"src"),{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>path.relative(root,path.join(entry.parentPath,entry.name))).sort().map(file=>({path:file,sha256:createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex")}));
result.source.workingTreeSourceSha256=createHash("sha256").update(appFiles.map(file=>`${file.sha256}  ${file.path}\n`).join("")).digest("hex");
result.source.sourceHashScope="All regular files under src; sorted sha256 + two spaces + relative path + newline";
result.environment.timezone=process.env.YASEIR_BROWSER_TIMEZONE??"browser default";
fs.writeFileSync(path.join(output,"source-files-sha256.json"),JSON.stringify(appFiles,null,2)+"\n");
const check = name => { result.checks.push({ name, status: "PASS" }); console.log(`PASS ${name}`); };
let created = false, gateway, browser, context, page, proxy, tlsCA, pendingDelivery = false;
const sockets = new Set(), pageErrors = [];
let cspProbePending = false, cspProbeInjected = false;
let serverLog = "";
function httpRequest(url, cookie = "", origin) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ca: tlsCA, method: origin ? "POST" : "GET", headers: {
      ...(cookie ? { cookie } : {}), ...(origin ? { origin, "content-type": "application/json" } : {}),
    } }, response => { let text = ""; response.on("data", c => { text += c; }); response.on("end", () => resolve({ status: response.statusCode, text })); });
    req.on("error", reject); req.setTimeout(10000, () => req.destroy(new Error("HTTP timeout")));
    req.end(origin ? JSON.stringify({ action: "revoke_others" }) : undefined);
  });
}
function waitForResponse(predicate) {
  const response = page.waitForResponse(predicate);
  // Observe rejection immediately while the click is pending. The original
  // promise is still awaited, so failure reaches the outer cleanup unchanged.
  void response.catch(() => undefined);
  return response;
}
async function api(endpoint, body) {
  return page.evaluate(async ({ endpoint, body }) => {
    const response = await fetch(endpoint, { method: body ? "POST" : "GET", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000),
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { endpoint, body });
}
async function passwordLogin(origin) {
  await page.goto(`${origin}/platform/login`);
  await page.locator("#platform-email").fill("browser-owner@example.invalid");
  await page.locator("#platform-password").fill(password);
  const response = waitForResponse(r => r.url().endsWith("/api/platform/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const login = await response; assert.equal(login.status(), 200);
  const payload = await login.json(); assert.equal(payload.ok, true);
  for (const field of ["accessToken", "refreshToken", "passwordHash", "credentialVersion"]) assert.equal(Object.hasOwn(payload, field), false);
  assert.match(login.headers()["cache-control"], /no-store/);
  await page.waitForURL("**/platform/dashboard");
  assert.equal((await api("/api/platform/auth/me")).status, 200);
}
async function stepUp(origin) {
  await page.goto(`${origin}/platform/security`);
  await page.locator("#security-password").fill(password);
  const confirmation = waitForResponse(r => r.url().endsWith("/api/platform/auth/reauth") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal((await confirmation).status(), 200);
  await page.getByText("Privileged access confirmed", { exact: true }).waitFor();
}
try {
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  const { migrateByHash } = await import(pathToFileURL(path.join(root, "scripts/db-migrate.ts")).href);
  const client = await db.connect(); try { await migrateByHash(client, path.join(root, "drizzle")); } finally { client.release(); }
  const { hashPassword } = await import(pathToFileURL(path.join(root, "src/lib/password.ts")).href);
  const userId = `browser_${randomBytes(12).toString("hex")}`;
  const platformTenantId = `tenant_${userId}`;
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic platform browser tenant')", [platformTenantId]);
  await db.query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES($1,$2,$3,now(),true)",
    [userId, "browser-owner@example.invalid", await hashPassword(password)]);
  const key = path.join(privateDir, "key.pem"), cert = path.join(privateDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "pipe" });
  tlsCA = fs.readFileSync(cert);
  const publicKey = execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
  const publicDer = execFileSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
  const certificatePin = createHash("sha256").update(publicDer).digest("base64");
  const portProbe = http.createServer(); await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), minVersion: "TLSv1.2" }, (request, response) => {
    const headers = { ...request.headers };
    for (const name of Object.keys(headers)) if (name.startsWith("x-forwarded-") || ["forwarded", "x-real-ip", "x-gateway-proxy-token"].includes(name)) delete headers[name];
    Object.assign(headers, { "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1", "x-gateway-proxy-token": proxyKey });
    // A dynamically appended script is allowed by strict-dynamic. Inject the
    // negative control into one real HTML response so the browser parser sees
    // a no-nonce script under the unchanged production response policy.
    const injectCspProbe = cspProbePending && request.method === "GET" && request.url === "/platform/dashboard";
    if (injectCspProbe) { cspProbePending = false; headers["accept-encoding"] = "identity"; }
    const upstream = http.request({ hostname: "127.0.0.1", port, path: request.url, method: request.method, headers }, res => {
      if (!injectCspProbe) { response.writeHead(res.statusCode, res.headers); res.pipe(response); return; }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const injected = body.replace("<head>", '<head><script id="yaseir-csp-acceptance-probe">window.__yaseirCspAcceptanceMarker = true</script>');
        cspProbeInjected = injected !== body;
        const responseHeaders = { ...res.headers }; delete responseHeaders["content-length"]; delete responseHeaders.etag;
        response.writeHead(res.statusCode, responseHeaders); response.end(injected);
      });
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    upstream.setTimeout(20000, () => upstream.destroy()); request.on("aborted", () => upstream.destroy()); request.pipe(upstream);
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `https://localhost:${proxy.address().port}`;
  gateway = spawn(process.execPath, ["--import", "./scripts/acceptance/registration-transport.fixture.mjs", "--import", "tsx", "server.ts"], { cwd: root, env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), APP_BASE_URL: origin,
    DATABASE_URL: connection.href, GATEWAY_JWT_SECRET: jwt, TRUST_PROXY: "1", TRUST_PROXY_SECRET: proxyKey,
    PLATFORM_TENANT_ID: platformTenantId,
    YASEIR_REGISTRATION_ACCEPTANCE_FIXTURE: "1", RESEND_API_KEY: "synthetic-not-a-provider-credential", EMAIL_FROM: "no-reply@example.invalid",
  }, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", c => { serverLog += c; }); gateway.stderr.on("data", c => { serverLog += c; });
  for (let i = 0; i < 120; i++) {
    if (gateway.exitCode !== null) throw new Error("Gateway exited before readiness");
    try { if ((await httpRequest(`${origin}/api/health`)).status === 200) break; } catch { /* bounded readiness */ }
    if (i === 119) throw new Error("Gateway readiness timed out");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const tool = process.env.PLAYWRIGHT_MODULE;
  const playwright = await import(tool ? pathToFileURL(path.resolve(tool)).href : "playwright");
  browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", `--ignore-certificate-errors-spki-list=${certificatePin}`] });
  result.environment.browser = browser.version();
  result.environment.playwright = tool ? JSON.parse(fs.readFileSync(path.join(path.dirname(tool), "package.json"), "utf8")).version : "installed Playwright";
  context = await browser.newContext({ ...(process.env.YASEIR_BROWSER_TIMEZONE?{timezoneId:process.env.YASEIR_BROWSER_TIMEZONE}:{}), ignoreHTTPSErrors: false, locale: "en-US", viewport: { width: 1440, height: 1100 } });
  result.environment.browserSecurity = { ignoreHTTPSErrors: false, bypassCSP: false, certificatePin: "single ephemeral fixture leaf SPKI" };
  await context.addCookies([{ name: "__Host-yaseir_locale", value: "en", url: origin, secure: true, sameSite: "Lax" }]);
  await context.addInitScript(() => { try { if (!localStorage.getItem("yaseir:locale")) localStorage.setItem("yaseir:locale", "en"); } catch { /* about:blank has no origin storage */ } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await passwordLogin(origin);
  if (process.env.YASEIR_ADMIN_BROWSER_MODULE) {
    const { adminBrowserAcceptance } = await import(pathToFileURL(path.resolve(process.env.YASEIR_ADMIN_BROWSER_MODULE)).href);
    await adminBrowserAcceptance({page,context,browser,db,origin,output,check,password,sensitive,baseline:process.env.YASEIR_BROWSER_BASELINE==='1'});
    assert.deepEqual(pageErrors, []); check("No JavaScript exceptions across manual subscription admin acceptance");
    result.status="PASS";
  } else {
  const authenticatedHtml = await page.goto(`${origin}/platform/dashboard`);
  assert.equal(authenticatedHtml.status(), 200);
  assert.match(authenticatedHtml.headers()["content-type"], /text\/html/);
  assert.equal(authenticatedHtml.headers()["cross-origin-opener-policy"], "same-origin");
  check("authenticated production HTML carries same-origin opener isolation");
  const loginCookies = await context.cookies();
  for (const name of ["__Host-plt_session", "__Host-plt_refresh"]) {
    const cookie = loginCookies.find(c => c.name === name);
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === "/");
    assert.equal(cookie.sameSite, name.endsWith("refresh") ? "Strict" : "Lax");
  }
  check("Platform password login immediately opens the dashboard with secure HttpOnly access and refresh cookies");
  const cspLogStart = serverLog.length;
  const cspReport = waitForResponse(r => new URL(r.url()).pathname === "/api/security/csp-report" && r.request().method() === "POST");
  cspProbePending = true;
  const cspHtml = await page.goto(`${origin}/platform/dashboard`);
  assert.equal(cspHtml.status(), 200);
  assert.match(cspHtml.headers()["content-type"], /text\/html/);
  assert.equal(cspProbeInjected, true);
  assert.equal(await page.locator("#yaseir-csp-acceptance-probe").count(), 1);
  assert.equal(await page.locator("#yaseir-csp-acceptance-probe").getAttribute("nonce"), null);
  const deliveredReport = await cspReport;
  assert.equal(deliveredReport.status(), 204);
  assert.equal(await page.evaluate(() => window.__yaseirCspAcceptanceMarker), undefined);
  const reportHeaders = await deliveredReport.request().allHeaders();
  assert.equal((reportHeaders.cookie ?? "").includes("__Host-plt_session="), true);
  for (let i = 0; i < 100 && !serverLog.slice(cspLogStart).includes('"event":"security.csp_violation"'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const cspEvents = serverLog.slice(cspLogStart).split("\n").flatMap(line => {
    try { const event = JSON.parse(line); return event.event === "security.csp_violation" ? [event] : []; }
    catch { return []; }
  });
  assert.ok(cspEvents.some(event => event.directive === "script-src-elem" && event.disposition === "enforce"));
  for (const event of cspEvents) assert.deepEqual(Object.keys(event).sort(), ["directive", "disposition", "event", "status", "ts"]);
  check("Enforcing CSP blocks a parser-inserted no-nonce script and delivers a bounded identity-free report with a real session cookie");
  const priorCookies = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  sensitive.push(priorCookies, ...(await context.cookies()).map(cookie => cookie.value));
  await context.clearCookies(); await context.addCookies([{ name: "__Host-yaseir_locale", value: "en", url: origin, secure: true, sameSite: "Lax" }]);
  await passwordLogin(origin);
  assert.equal((await api("/api/platform/auth/sessions")).data.sessions.length, 2);
  check("Password login on a second device creates a separate visible session family");
  await db.query("UPDATE platform_session_security SET password_verified_at=now()-interval '10 minutes' WHERE user_id=$1", [userId]);
  assert.equal((await api("/api/platform/auth/sessions", { action: "revoke_others" })).status, 403);
  check("A stale assurance cannot perform privileged session revocation");
  await stepUp(origin);
  const revoke = waitForResponse(r => r.url().endsWith("/api/platform/auth/sessions") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign out other sessions", exact: true }).click();
  assert.equal((await revoke).status(), 200);
  assert.equal((await httpRequest(`${origin}/api/platform/auth/me`, priorCookies)).status, 401);
  assert.equal((await api("/api/platform/auth/sessions")).data.sessions.length, 1);
  check("Fresh password confirmation revokes the other device session");
  await page.locator("#security-password").waitFor();
  assert.equal(await page.locator("#security-password").inputValue(), "");
  assert.equal(await page.getByText("Privileged access confirmed", { exact: true }).count(), 0);
  check("Session revocation clears local management confirmation and the password field");
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of [password, ...(await context.cookies()).filter(c => /_(?:session|refresh)$/.test(c.name)).map(c => c.value)]) {
    assert.equal(storage.includes(secret), false, "Passwords and session tokens must not enter browser storage");
  }
  check("The browser stores neither the password nor readable session tokens in web storage");
  const currentCookies = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; "); sensitive.push(currentCookies);
  assert.equal((await httpRequest(`${origin}/api/platform/auth/sessions`, currentCookies, "https://attacker.invalid")).status, 403);
  check("Cross-origin administrative mutation is rejected with a real production cookie");
  await page.goto(`${origin}/platform/security`);
  await page.getByRole("heading", { name: "Security", exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "platform-security-en.png"), fullPage: true });
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await page.getByRole("menuitem", { name: "العربية", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl");
  const localeCookie = (await context.cookies()).find(cookie => cookie.name === "__Host-yaseir_locale");
  assert.ok(localeCookie?.secure && localeCookie.path === "/" && localeCookie.value === "ar");
  assert.ok(!(await context.cookies()).some(cookie => cookie.name === "yaseir_locale"));
  await page.reload(); await page.waitForFunction(() => document.documentElement.dir === "rtl");
  await page.screenshot({ path: path.join(output, "platform-security-ar.png"), fullPage: true });
  check("English and Arabic security UI renders with empty password fields");
  assert.deepEqual(pageErrors, []); check("No browser JavaScript exceptions");
  assert.equal((await api("/api/platform/auth/logout", {})).status, 200);
  assert.equal((await api("/api/platform/auth/me")).status, 401);
  check("Explicit logout revokes the active browser session");
  await workspaceBrowserAcceptance({ page, context, db, origin, output, check, password, httpRequest, sensitive });
  assert.deepEqual(pageErrors, []); check("No JavaScript exceptions across platform and workspace security flows");
  const registration = await api("/api/auth/register", { email: "delivery-case@example.invalid", password });
  assert.equal(registration.status, 202);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE email='delivery-case@example.invalid'")).rows[0].n, 1);
  assert.ok(!serverLog.includes('"event":"fixture.email.completed"'), "Registration awaited account-dependent provider delivery");
  for (let i = 0; i < 100 && !serverLog.includes('"event":"fixture.email.started"'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(serverLog.includes('"event":"fixture.email.started"'), "Next after() delivery callback did not start");
  pendingDelivery = true;
  check("Registration commits before generic202 and does not wait for provider delivery");
  result.status = "PASS";
  }
} catch (error) {
  result.failure = redact(error.stack || error.message || error); console.error(result.failure);
} finally {
  try { await browser?.close(); } catch (error) { result.status = "FAIL"; result.browserCleanupFailure = redact(error.message); }
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    let timer;
    const exited = await Promise.race([once(gateway, "exit").then(([code, signal]) => ({ code, signal })), new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]);
    clearTimeout(timer);
    if (!exited || exited.code !== 0) { gateway.kill("SIGKILL"); result.status = "FAIL"; result.gatewayCleanupFailure = exited || "shutdown timeout"; }
    else {
      result.gatewayShutdown = { status: "PASS", exitCode: 0 };
      if (pendingDelivery) {
        if (!serverLog.includes('"event":"fixture.email.completed"')) { result.status = "FAIL"; result.afterDrainFailure = "Gateway exited before tracked Next after() delivery completed"; }
        else check("SIGTERM drains the real Next after() callback before clean exit");
      }
    }
  } else if (gateway) { result.status = "FAIL"; result.gatewayCleanupFailure = { exitCode: gateway.exitCode }; }
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  try {
    await db.end();
    if (created) { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [database]); await admin.query(`DROP DATABASE "${database}"`); }
    await admin.end(); result.databaseCleanup = "PASS";
  } catch (error) { result.status = "FAIL"; result.databaseCleanupFailure = redact(error.message); }
  fs.rmSync(privateDir, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, "gateway.log"), redact(serverLog));
  fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, result: path.join(output, "result.json") }));
  if (result.status !== "PASS") process.exitCode = 1;
}
