/** Real Chromium acceptance for the production opener-policy header.
 * Uses two disposable loopback origins and synthetic cookies. This verifies
 * opener isolation and navigation, not payment processing or deployed TLS.
 * Set YASEIR_PLAYWRIGHT_MODULE and YASEIR_CHROMIUM_EXECUTABLE to verified tools.
 * node --import tsx scripts/acceptance/coop-browser.mts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { applyHttpSecurityHeaders } from "../../src/server/api-defaults";
import { createRequestContentSecurityPolicy } from "../../src/server/content-security-policy";

const playwrightModule = process.env.YASEIR_PLAYWRIGHT_MODULE;
const executablePath = process.env.YASEIR_CHROMIUM_EXECUTABLE;
assert(playwrightModule && executablePath, "Set both verified browser tool paths");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
process.env.NODE_ENV = "production";
let gatewayOrigin = "";
let externalOrigin = "";
let returnCookiePresent = false;
const cookieName = "coop_synthetic_session";
const gateway = createServer((req, res) => {
  applyHttpSecurityHeaders(res);
  const { policy } = createRequestContentSecurityPolicy();
  res.setHeader("Content-Security-Policy", policy);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/billing-return") {
    returnCookiePresent = req.headers.cookie?.includes(`${cookieName}=fixture`) === true;
    res.end("<!doctype html><title>Gateway return</title><p id='returned'>Returned to Gateway</p>");
  } else {
    res.setHeader("Set-Cookie", `${cookieName}=fixture; Path=/; HttpOnly; SameSite=Strict`);
    res.end("<!doctype html><title>Gateway fixture</title><p>Gateway page</p>");
  }
});
const external = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>External fixture</title><a id="return" href="${gatewayOrigin}/billing-return">Return</a>`);
});
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
gatewayOrigin = await listen(gateway);
externalOrigin = await listen(external);
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const report: Record<string, unknown> = {
  success: false, browser_version: browser.version(),
  scope: "Real Chromium and production header/CSP generators on two loopback origins; synthetic same-tab external navigation, not payment processing or deployed TLS; no COEP change",
};
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  const attacker = await context.newPage();
  await attacker.goto(externalOrigin);
  const opened = context.waitForEvent("page");
  await attacker.evaluate((url: string) => { window.open(url, "cross-origin-gateway"); }, `${gatewayOrigin}/opened`);
  const popup = await opened;
  await popup.waitForURL(`${gatewayOrigin}/opened`);
  await popup.waitForLoadState("domcontentloaded");
  report.cross_origin_opener_is_null = await popup.evaluate(() => window.opener === null);
  assert.equal(report.cross_origin_opener_is_null, true, "Cross-origin opener must be severed by the production header");
  await popup.close();

  const gatewayPage = await context.newPage();
  const response = await gatewayPage.goto(gatewayOrigin);
  report.header = response?.headers()["cross-origin-opener-policy"];
  assert.equal(report.header, "same-origin");
  const sameOriginOpened = context.waitForEvent("page");
  await gatewayPage.evaluate((url: string) => { window.open(url, "same-origin-gateway"); }, `${gatewayOrigin}/same-origin`);
  const sameOriginPopup = await sameOriginOpened;
  await sameOriginPopup.waitForURL(`${gatewayOrigin}/same-origin`);
  await sameOriginPopup.waitForLoadState("domcontentloaded");
  report.same_origin_opener_preserved = await sameOriginPopup.evaluate(() => window.opener !== null);
  assert.equal(report.same_origin_opener_preserved, true);
  await sameOriginPopup.close();

  const pageCount = context.pages().length;
  // Preserve the generic external-navigation check after retirement of the
  // provider billing flow. The fixture does not exercise an active checkout.
  await Promise.all([
    gatewayPage.waitForURL(`${externalOrigin}/checkout`),
    gatewayPage.evaluate((url: string) => { window.location.href = url; }, `${externalOrigin}/checkout`),
  ]);
  await Promise.all([gatewayPage.waitForURL(`${gatewayOrigin}/billing-return`), gatewayPage.locator("#return").click()]);
  assert.equal(await gatewayPage.locator("#returned").textContent(), "Returned to Gateway");
  assert.equal(context.pages().length, pageCount);
  assert.equal(returnCookiePresent, true);
  const cookies = await context.cookies(gatewayOrigin);
  assert(cookies.some((cookie: { name: string; value: string; httpOnly: boolean }) => cookie.name === cookieName && cookie.value === "fixture" && cookie.httpOnly));
  report.same_tab_external_return = true;
  report.synthetic_session_cookie_preserved = true;
  report.success = true;
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  for (const server of [gateway, external]) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
