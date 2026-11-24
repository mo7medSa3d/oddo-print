/** Real compiled-application workspace password/session flow, called by platform-browser. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { hashPassword } from "../../src/lib/password.ts";

export async function workspaceBrowserAcceptance({ page, context, db, origin, output, check, password, httpRequest, sensitive }) {
  const suffix = randomBytes(10).toString("hex"), userId = `workspace_${suffix}`, tenantId = `tenant_workspace_${suffix}`;
  const email = "workspace-browser@example.invalid", exactPassword = ` ${password} `;
  sensitive.push(exactPassword);
  const request = async (endpoint, body, method = body === undefined ? "GET" : "POST") => page.evaluate(async ({ endpoint, body, method }) => {
    const response = await fetch(endpoint, { method, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { endpoint, body, method });
  const read = endpoint => request(endpoint);
  const rememberCookies = async () => { const cookies = await context.cookies(); sensitive.push(...cookies.map(cookie => cookie.value)); return cookies; };
  const cookieHeader = async () => { const value = (await rememberCookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; "); sensitive.push(value); return value; };
  function waitForResponse(predicate) {
    const response = page.waitForResponse(predicate);
    // Observe rejection while a click is pending; the awaited original still
    // rejects and reaches the caller's cleanup on a browser/network timeout.
    void response.catch(() => undefined);
    return response;
  }
  function assertPublic(payload) {
    for (const key of ["token", "accessToken", "refreshToken", "credentialVersion", "passwordHash", "sessionId", "familyId"]) {
      assert.equal(Object.hasOwn(payload, key), false, `No ${key} in workspace browser login JSON`);
    }
  }
  async function assertNoSecretStorage() {
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [exactPassword, ...(await rememberCookies()).filter(c => /_(?:session|refresh)$/.test(c.name)).map(c => c.value)]) {
      assert.equal(storage.includes(secret), false, "Workspace credentials and session tokens must not enter browser storage");
    }
  }
  async function passwordLogin(next = "/settings") {
    await page.goto(`${origin}/login?next=${encodeURIComponent(next)}`);
    await page.locator("#email").fill(email); await page.locator("#password").fill(exactPassword);
    const login = waitForResponse(response => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
    await page.locator('form button[type="submit"]').click();
    const response = await login;
    assert.equal(response.status(), 200);
    const payload = await response.json(); assertPublic(payload);
    assert.equal(payload.ok, true); assert.equal(payload.tenantId, tenantId); assert.equal(payload.role, "owner");
    assert.equal(response.request().postDataJSON().password, exactPassword);
    assert.match(response.headers()["cache-control"], /no-store/);
    await page.waitForURL(url => url.pathname === new URL(next, origin).pathname);
    assert.equal((await read("/api/auth/me")).status, 200);
    return response;
  }
  async function authenticatedLogin() {
    await context.clearCookies(); await context.addCookies([{ name: "__Host-yaseir_locale", value: "en", url: origin, secure: true, sameSite: "Lax" }]);
    await passwordLogin();
    // Ordinary Settings intentionally starts with its security details closed.
    // Open the real control as an operator would before interacting with it.
    const securityDetails = page.locator("details").filter({ has: page.locator("#workspace-security") });
    await securityDetails.locator("summary").click();
    await page.locator("#workspace-confirm-password").waitFor();
    const state = (await db.query(`SELECT s.family_id FROM workspace_session_security s JOIN refresh_tokens r ON r.family_id=s.family_id
      WHERE s.user_id=$1 AND r.kind='customer' AND r.revoked_at IS NULL AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
      AND s.expires_at>clock_timestamp() ORDER BY r.issued_at DESC,r.id LIMIT 1`, [userId])).rows[0];
    assert.ok(state); await rememberCookies(); return state.family_id;
  }
  async function assertExpiredEverywhere(familyId, label) {
    const before = (await db.query("SELECT last_seen_at FROM workspace_session_security WHERE family_id=$1", [familyId])).rows[0].last_seen_at.toISOString();
    for (const endpoint of ["/api/auth/me", "/api/auth/reauth/status"]) assert.equal((await read(endpoint)).status, 401);
    for (const endpoint of ["/api/auth/activity", "/api/auth/refresh"]) assert.equal((await request(endpoint, undefined, "POST")).status, 401);
    assert.equal((await db.query("SELECT last_seen_at FROM workspace_session_security WHERE family_id=$1", [familyId])).rows[0].last_seen_at.toISOString(), before);
    check(`${label} fails at access, status, activity and refresh without reviving the family`);
  }
  async function screenshotWithoutSecrets(filename) {
    for (const field of await page.locator('input[type="password"]').all()) assert.equal(await field.inputValue(), "");
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
  }
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic workspace acceptance')", [tenantId]);
  await db.query("INSERT INTO users(id,email,password_hash,email_verified_at) VALUES($1,$2,$3,now())", [userId, email, await hashPassword(exactPassword)]);
  await db.query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES($1,$2,'owner')", [userId, tenantId]);
  await context.clearCookies();
  await context.addCookies([{ name: "__Host-yaseir_locale", value: "en", url: origin, secure: true, sameSite: "Lax" }]);
  await page.evaluate(() => localStorage.setItem("yaseir:locale", "en"));
  await passwordLogin("/settings?reauth=1&returnTo=%2Fdashboard");
  await page.locator("#workspace-confirm-password").waitFor();
  const initialCookies = await rememberCookies();
  for (const name of ["__Host-cust_session", "__Host-cust_refresh"]) {
    const cookie = initialCookies.find(c => c.name === name);
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === "/");
    assert.equal(cookie.sameSite, name.endsWith("refresh") ? "Strict" : "Lax");
  }
  await assertNoSecretStorage();
  check("Password login preserves exact whitespace, immediately opens the workspace, and issues only secure HttpOnly session cookies");
  const before = (await db.query("SELECT family_id,last_seen_at,expires_at FROM workspace_session_security WHERE user_id=$1", [userId])).rows[0];
  const originalDeadline = (await read("/api/auth/reauth/status")).data.absoluteExpiresAt;
  assert.equal((await read("/api/auth/me")).status, 200);
  assert.equal((await read("/api/auth/reauth/status")).status, 200);
  assert.equal((await db.query("SELECT last_seen_at FROM workspace_session_security WHERE family_id=$1", [before.family_id])).rows[0].last_seen_at.toISOString(), before.last_seen_at.toISOString());
  check("Background session/status probes do not extend workspace idle activity");
  await db.query("UPDATE workspace_session_security SET created_at=now()-interval '10 minutes',password_verified_at=now()-interval '10 minutes',last_seen_at=now()-interval '2 minutes' WHERE family_id=$1", [before.family_id]);
  await page.reload(); await page.locator("#workspace-confirm-password").waitFor();
  const activity = waitForResponse(response => response.url().endsWith("/api/auth/activity") && response.request().method() === "POST");
  await page.locator("#workspace-name").click(); assert.equal((await activity).status(), 204);
  const stateAfterActivity = (await db.query(`SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000 AS now_ms,
    EXTRACT(EPOCH FROM last_seen_at)*1000 AS last_seen_ms, EXTRACT(EPOCH FROM password_verified_at)*1000 AS password_verified_ms
    FROM workspace_session_security WHERE family_id=$1`, [before.family_id])).rows[0];
  const idleAge = Number(stateAfterActivity.now_ms) - Number(stateAfterActivity.last_seen_ms);
  const passwordAge = Number(stateAfterActivity.now_ms) - Number(stateAfterActivity.password_verified_ms);
  assert.ok(Number.isFinite(idleAge) && idleAge >= 0 && idleAge < 15000);
  assert.ok(Number.isFinite(passwordAge) && passwordAge > 5 * 60 * 1000 && passwordAge < 11 * 60 * 1000);
  assert.equal((await read("/api/auth/reauth/status")).data.reauthenticationRequired, true);
  check("Trusted foreground input extends idle activity without manufacturing fresh password proof");
  await page.locator("#workspace-name").fill("Explicitly accepted workspace change");
  const denied = waitForResponse(response => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
  await page.locator("form").filter({ has: page.locator("#workspace-name") }).locator('button[type="submit"]').click();
  const deniedResponse = await denied;
  assert.equal(deniedResponse.status(), 403); assert.equal(deniedResponse.headers()["x-yaseir-reauthentication"], "required");
  assert.equal((await deniedResponse.json()).code, "WORKSPACE_REAUTHENTICATION_REQUIRED");
  assert.equal((await db.query("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0].name, "Synthetic workspace acceptance");
  await page.getByTestId("workspace-reauthentication-notice").getByRole("link").click();
  await page.locator("#workspace-confirm-password").fill("incorrect-password");
  const incorrect = waitForResponse(response => response.url().endsWith("/api/auth/reauth/password") && response.request().method() === "POST");
  await page.locator("#workspace-confirm-identity").click();
  const incorrectResponse = await incorrect; assert.equal(incorrectResponse.status(), 403); assert.equal((await incorrectResponse.json()).code, "PASSWORD_CONFIRMATION_FAILED");
  await page.getByTestId("workspace-security-result").waitFor();
  assert.equal(await page.locator("#workspace-confirm-password").inputValue(), "");
  assert.equal((await context.cookies()).find(c => c.name === "__Host-cust_session").value, initialCookies.find(c => c.name === "__Host-cust_session").value);
  check("A stale mutation and wrong password are denied; the UI clears the password and preserves the existing session");
  const oldCookies = await cookieHeader();
  await page.locator("#workspace-confirm-password").fill(exactPassword);
  const confirmed = waitForResponse(response => response.url().endsWith("/api/auth/reauth/password") && response.request().method() === "POST");
  await page.locator("#workspace-confirm-identity").click();
  assert.equal((await confirmed).status(), 200);
  await page.getByTestId("workspace-security-result").getByText("Identity confirmed", { exact: true }).waitFor();
  assert.equal(await page.locator("#workspace-confirm-password").inputValue(), "");
  const payload = (await read("/api/auth/reauth/status")).data;
  assert.equal(payload.kind, "customer"); assert.equal(payload.reauthenticationRequired, false); assert.equal(payload.absoluteExpiresAt, originalDeadline);
  const rotatedCookies = await rememberCookies();
  for (const name of ["__Host-cust_session", "__Host-cust_refresh"]) assert.notEqual(rotatedCookies.find(c => c.name === name).value, initialCookies.find(c => c.name === name).value);
  assert.equal((await httpRequest(`${origin}/api/auth/me`, oldCookies)).status, 401);
  assert.equal((await db.query("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0].name, "Synthetic workspace acceptance");
  const returnHref = await page.locator("#workspace-return-to-task").getAttribute("href");
  assert.equal(new URL(returnHref, origin).origin, origin); assert.ok(new URL(returnHref, origin).pathname.startsWith("/settings"));
  await assertNoSecretStorage();
  check("Password confirmation rotates both cookies, rejects old access, preserves absolute expiry and never replays the mutation");
  await page.locator("#workspace-return-to-task").click();
  await page.locator("#workspace-name").fill("Explicitly accepted workspace change");
  const saved = waitForResponse(response => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
  await page.locator("form").filter({ has: page.locator("#workspace-name") }).locator('button[type="submit"]').click();
  assert.equal((await saved).status(), 200);
  assert.equal((await db.query("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0].name, "Explicitly accepted workspace change");
  await screenshotWithoutSecrets("workspace-security-en.png"); check("The operator explicitly resubmits the authorized change after confirmation");
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await page.getByRole("menuitem", { name: "العربية", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl"); await page.reload();
  await page.waitForFunction(() => document.documentElement.dir === "rtl"); await page.locator("#workspace-security").waitFor();
  await screenshotWithoutSecrets("workspace-security-ar.png"); check("English and Arabic workspace security UI renders with empty password fields");
  await context.addCookies([{ name: "__Host-yaseir_locale", value: "en", url: origin, secure: true, sameSite: "Lax" }]);
  await page.evaluate(() => localStorage.setItem("yaseir:locale", "en"));
  await db.query("UPDATE workspace_session_security SET created_at=now()-interval '35 minutes',password_verified_at=now()-interval '32 minutes',last_seen_at=now()-interval '31 minutes' WHERE family_id=$1", [before.family_id]);
  await assertExpiredEverywhere(before.family_id, "Idle-expired workspace activity");
  const absoluteFamily = await authenticatedLogin();
  await db.query(`UPDATE workspace_session_security SET created_at=now()-interval '2 hours',password_verified_at=now()-interval '2 minutes',
    last_seen_at=now()-interval '90 seconds',expires_at=now()-interval '1 minute' WHERE family_id=$1`, [absoluteFamily]);
  await assertExpiredEverywhere(absoluteFamily, "Absolute-expired workspace access despite recent activity");
  await authenticatedLogin(); const otherDeviceCookies = await cookieHeader(); await authenticatedLogin();
  await page.locator("#session-password").fill(exactPassword);
  const swept = waitForResponse(response => response.url().endsWith("/api/auth/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sign out other sessions", exact: true }).click(); assert.equal((await swept).status(), 200);
  await page.waitForFunction(() => document.querySelector("#session-password")?.value === "");
  assert.equal((await httpRequest(`${origin}/api/auth/me`, otherDeviceCookies)).status, 401);
  assert.equal((await read("/api/auth/me")).status, 200); await assertNoSecretStorage();
  check("Password-confirmed session sweep revokes the other device and preserves the current family");
  assert.equal((await request("/api/auth/logout", {})).status, 200); assert.equal((await read("/api/auth/me")).status, 401);
  check("Workspace logout revokes the active session"); await context.clearCookies();
}
