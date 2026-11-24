import type * as NextServerModule from "next/server";
import type * as PasswordScreeningModule from "../src/lib/password-screening";
import type * as ServerModule from "../src/i18n/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import { hashPassword, hashToken } from "../src/lib/password";

const delivery = vi.hoisted(() => ({
  callbacks: [] as Array<() => Promise<void>>,
  messages: [] as Array<{ to: string; html: string; text: string }>,
  locale: "en" as "en" | "ar",
}));
// Only external delivery, breach lookup and Next's post-response scheduling
// boundary are controlled. Routes, KDF, rate limiter and PostgreSQL are real.
vi.mock("next/server", async importActual => ({
  ...await importActual<typeof NextServerModule>(),
  after: (callback: () => Promise<void>) => { delivery.callbacks.push(callback); },
}));
vi.mock("../src/lib/email", () => ({
  appBaseUrl: () => "https://gateway.test",
  sendTransactionalEmail: async (message: { to: string; html: string; text: string }) => { delivery.messages.push(message); },
}));
vi.mock("../src/lib/password-screening", async importActual => ({
  ...await importActual<typeof PasswordScreeningModule>(),
  screenNewPassword: vi.fn(async () => "acceptable"),
}));
vi.mock("../src/i18n/server", async importActual => ({
  ...await importActual<typeof ServerModule>(),
  getServerLocale: async () => delivery.locale,
}));

import { POST as register } from "../src/app/api/auth/register/route";
import { POST as resend } from "../src/app/api/auth/resend-verification/route";
import { POST as forgot } from "../src/app/api/auth/forgot-password/route";
import { POST as verify } from "../src/app/api/auth/verify-email/route";
import { POST as reset } from "../src/app/api/auth/reset-password/route";
import { POST as acceptInvitation } from "../src/app/api/team/invitations/accept/route";

type Flow = "verification" | "reset";
const password = `Email proof ${randomBytes(20).toString("hex")} !`;
let passwordHash: string;
const request = (path: string, body: Record<string, unknown>) => new Request(`https://gateway.test${path}`, {
  method: "POST", headers: { origin: "https://gateway.test", "content-type": "application/json" }, body: JSON.stringify(body),
});
const tokenTable = (flow: Flow) => flow === "verification" ? "email_verification_tokens" : "password_reset_tokens";
const present = (flow: Flow, token: string) => flow === "verification"
  ? verify(request("/api/auth/verify-email", { token }))
  : reset(request("/api/auth/reset-password", { token, password }));

async function proof(flow: Flow, ageSeconds = 0, remainingSeconds = 1800) {
  const token = randomBytes(32).toString("base64url");
  await pool().query(`INSERT INTO ${tokenTable(flow)}(id,user_id,token_hash,created_at,expires_at)
    VALUES ('proof','user',$1,clock_timestamp()-$2*interval '1 second',clock_timestamp()+$3*interval '1 second')`,
  [await hashToken(token), ageSeconds, remainingSeconds]);
  return token;
}
async function boundedIssuedToken(flow: Flow, email = "person@example.test") {
  const result = await pool().query(`SELECT EXTRACT(EPOCH FROM (t.expires_at-clock_timestamp()))*1000 AS remaining_ms,
    EXTRACT(EPOCH FROM (t.created_at-clock_timestamp()))*1000 AS created_offset_ms
    FROM ${tokenTable(flow)} t JOIN users u ON u.id=t.user_id WHERE u.email=$1 AND t.consumed_at IS NULL`, [email]);
  expect(result.rows).toHaveLength(1);
  const { remaining_ms: remaining, created_offset_ms: created } = result.rows[0];
  expect(Number(remaining)).toBeGreaterThan(590_000);
  expect(Number(remaining)).toBeLessThanOrEqual(600_000);
  expect(Number(created)).toBeLessThanOrEqual(0);
  expect(Number(created)).toBeGreaterThan(-10_000);
}
async function expectIdentityUntouched(flow: Flow) {
  const account = (await pool().query("SELECT password_hash,email_verified_at FROM users WHERE id='user'")).rows[0];
  expect(account.password_hash === passwordHash).toBe(true);
  expect(account.email_verified_at).toBeNull();
  expect((await pool().query(`SELECT consumed_at FROM ${tokenTable(flow)} WHERE id='proof'`)).rows[0].consumed_at).toBeNull();
  expect((await pool().query("SELECT 1 FROM refresh_tokens")).rows).toHaveLength(0);
  expect((await pool().query("SELECT user_id,tenant_id,role FROM tenant_users")).rows).toEqual([{ user_id: "user", tenant_id: "tenant", role: "owner" }]);
  if (flow === "verification") expect((await pool().query("SELECT 1 FROM password_reset_tokens")).rows).toHaveLength(0);
}
async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await pool().query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Email proof did not reach the expected transaction fence");
}

describe.skipIf(!hasTestDatabase)("email authentication proof lifetime", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(48).toString("base64url");
    process.env.APP_BASE_URL = "https://gateway.test";
    await applyMigrations();
    passwordHash = await hashPassword(password);
  });
  beforeEach(async () => {
    await truncateAll();
    delivery.callbacks.length = 0;
    delivery.messages.length = 0;
    delivery.locale = "en";
    await pool().query("INSERT INTO tenants(id,name) VALUES ('tenant','Existing workspace')");
    await pool().query("INSERT INTO users(id,email,password_hash) VALUES ('user','person@example.test',$1)", [passwordHash]);
    await pool().query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES ('user','tenant','owner')");
  });
  afterAll(closePool);

  it("caps registration proof at ten minutes using the database clock", async () => {
    const result = await register(request("/api/auth/register", { email: "new@example.test", displayName: "New Customer" }));
    expect(result.status).toBe(202);
    expect(result.headers.get("set-cookie")).toBeNull();
    await boundedIssuedToken("verification", "new@example.test");
  });
  it("caps replacement verification proof and consumes its predecessor", async () => {
    await proof("verification");
    expect((await resend(request("/api/auth/resend-verification", { email: "person@example.test" }))).status).toBe(202);
    await boundedIssuedToken("verification");
    expect((await pool().query("SELECT consumed_at FROM email_verification_tokens WHERE id='proof'")).rows[0].consumed_at).not.toBeNull();
  });
  it("caps invitation onboarding proof without granting a membership or session", async () => {
    const invitation = randomBytes(32).toString("base64url");
    await pool().query("INSERT INTO tenant_invitations(id,tenant_id,inviter_user_id,email,role,token_hash,expires_at) VALUES ('invitation','tenant','user','invited@example.test','admin',$1,clock_timestamp()+interval '1 day')", [await hashToken(invitation)]);
    expect((await acceptInvitation(request("/api/team/invitations/accept", { token: invitation }))).status).toBe(202);
    await boundedIssuedToken("verification", "invited@example.test");
    expect((await pool().query("SELECT 1 FROM tenant_users")).rows).toHaveLength(1);
    expect((await pool().query("SELECT 1 FROM refresh_tokens")).rows).toHaveLength(0);
    expect((await pool().query("SELECT invitation_id FROM email_verification_tokens")).rows[0].invitation_id).toBe("invitation");
  });
  it("caps password recovery proof without issuing an authentication session", async () => {
    expect((await forgot(request("/api/auth/forgot-password", { email: "person@example.test" }))).status).toBe(202);
    await boundedIssuedToken("reset");
    expect((await pool().query("SELECT 1 FROM refresh_tokens")).rows).toHaveLength(0);
    expect(delivery.messages).toHaveLength(0);
    expect(delivery.callbacks).toHaveLength(1);
    const stored = (await pool().query("SELECT token_hash,created_at,expires_at FROM password_reset_tokens WHERE user_id='user' AND consumed_at IS NULL")).rows[0];
    await delivery.callbacks[0]();
    expect(delivery.messages).toHaveLength(1);
    expect(delivery.messages[0].to).toBe("person@example.test");
    const link = /href="([^"]+)"/.exec(delivery.messages[0].html)?.[1];
    const token = link ? new URL(link).searchParams.get("token") : null;
    // Compare only digests/booleans so an assertion failure never prints the
    // synthetic recovery proof contained in the email.
    expect(token !== null && await hashToken(token) === stored.token_hash).toBe(true);
    expect((await pool().query("SELECT token_hash,created_at,expires_at FROM password_reset_tokens WHERE user_id='user' AND consumed_at IS NULL")).rows[0]).toEqual(stored);
  });
  it("caps the mailbox-owner password-setup continuation", async () => {
    const token = await proof("verification");
    const response = await present("verification", token);
    expect(response.status).toBe(200);
    expect((await response.json()).requiresPasswordSetup).toBe(true);
    await boundedIssuedToken("reset");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each(["verification", "reset"] as const)("rejects a legacy %s proof at the ten-minute boundary without mutations", async flow => {
    const token = await proof(flow, 600);
    expect((await present(flow, token)).status).toBe(400);
    await expectIdentityUntouched(flow);
  });
  it.each(["verification", "reset"] as const)("rejects an older %s proof even when its persisted expiry is still future", async flow => {
    const token = await proof(flow, 900);
    expect((await present(flow, token)).status).toBe(400);
    await expectIdentityUntouched(flow);
  });
  it.each(["verification", "reset"] as const)("rejects a future-created %s proof", async flow => {
    const token = await proof(flow, -60);
    expect((await present(flow, token)).status).toBe(400);
    await expectIdentityUntouched(flow);
  });
  it.each(["verification", "reset"] as const)("preserves an earlier stored %s expiry", async flow => {
    const token = await proof(flow, 60, -1);
    expect((await present(flow, token)).status).toBe(400);
    await expectIdentityUntouched(flow);
  });
  it.each(["verification", "reset"] as const)("allows one concurrent use of a live %s proof and rejects reuse", async flow => {
    const token = await proof(flow, 590);
    const responses = await Promise.all([present(flow, token), present(flow, token)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    expect((await present(flow, token)).status).toBe(400);
    expect((await pool().query(`SELECT consumed_at FROM ${tokenTable(flow)} WHERE id='proof'`)).rows[0].consumed_at).not.toBeNull();
  });
  it.each(["verification", "reset"] as const)("rechecks %s age after waiting for the user lock", async flow => {
    const token = await proof(flow, 596);
    const blocker = await pool().connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() n")).rows[0].n;
      await blocker.query("SELECT id FROM users WHERE id='user' FOR UPDATE");
      pending = present(flow, token);
      await waitForBlockedBy(pid);
      // Wait only for the final few seconds of the real PostgreSQL deadline;
      // changing the application clock cannot advance or extend this proof.
      await pool().query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (created_at+interval '10 minutes'-clock_timestamp())))+0.05) FROM ${tokenTable(flow)} WHERE id='proof'`);
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(400);
      await expectIdentityUntouched(flow);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) await pending;
    }
  });
  it.each(["en", "ar"] as const)("states the ten-minute verification lifetime in the actual %s email", async locale => {
    delivery.locale = locale;
    expect((await resend(request("/api/auth/resend-verification", { email: "person@example.test" }))).status).toBe(202);
    expect(delivery.messages).toHaveLength(0);
    expect(delivery.callbacks).toHaveLength(1);
    await delivery.callbacks[0]();
    expect(delivery.messages).toHaveLength(1);
    // Inspect only the expiry sentence so a failing assertion cannot print
    // the live synthetic proof embedded in the preceding URL.
    expect(delivery.messages[0].text.split("\n").at(-1)).toContain("10");
  });
});
