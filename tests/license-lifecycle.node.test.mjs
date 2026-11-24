import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load the real `src/lib/license-signer.ts` directly in Node without a
 * TypeScript transpiler dependency by stripping static type annotations.
 */
async function loadRealLicenseSigner() {
  const srcPath = path.resolve(process.cwd(), "src/lib/license-signer.ts");
  let src = fs.readFileSync(srcPath, "utf8");

  src = src.replace(/^export\s+type\s+[^;]+;\s*$/gm, "");
  src = src.replace(/^export\s+interface\s+\w+(?:<[^>]+>)?\s*\{[\s\S]*?^\}\s*$/gm, "");
  src = src.replace(/\b(const|let)\s+(\w+)\s*:\s*[A-Za-z0-9_<>|\[\]\s]+?(\s*[=;])/g, "$1 $2$3");
  src = src.replace(
    /((?:export\s+)?function\s+\w+)(?:\s*<[^>]+>)?\s*\(([\s\S]*?)\)\s*:\s*(?:\{[^\n]+\}(?:\s*\|\s*\{[^\n]+\})?|[A-Za-z0-9_<>|\[\]]+)\s*\{/g,
    (_match, fnHead, rawParams) => {
      const cleanParams = rawParams.replace(/(\b\w+)\??\s*:\s*[^,=)]+/g, "$1");
      return `${fnHead}(${cleanParams}) {`;
    },
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "license-lifecycle-test-"));
  const tmpFile = path.join(tmpDir, "license-signer.mjs");
  fs.writeFileSync(tmpFile, src, "utf8");
  try {
    return await import(pathToFileURL(tmpFile).href);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const signer = await loadRealLicenseSigner();
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const otherKeypair = generateKeyPairSync("ed25519");
const otherPubPem = otherKeypair.publicKey.export({ type: "spki", format: "pem" }).toString();

const T0 = Date.parse("2026-11-22T12:00:00.000Z");
const EXPIRES_1 = "2026-12-22T12:00:00.000Z";
const GRACE_1 = "2026-12-29T12:00:00.000Z";
const IN_GRACE_1 = Date.parse("2026-12-25T12:00:00.000Z");
const AFTER_EXPIRE_1 = Date.parse("2026-12-30T12:00:00.000Z");
const EXPIRES_2 = "2027-01-22T12:00:00.000Z";
const GRACE_2 = "2027-01-29T12:00:00.000Z";

test("Full lifecycle: issue -> activate -> validate -> grace -> renew -> expire -> revoke", () => {
  // 1. ISSUE: Ed25519 signed v2 bundle with monotonic rev, plan_id, max_printers, expires_at, grace_until, status
  const issued = signer.issueLicenseBundle(
    {
      license_id: "lic_tenant_01",
      tenant_id: "ten_01",
      odoo_db_uuid: "db-uuid-prod-01",
      plan_id: "pro",
      key_id: "k1",
      max_agents: 5,
      max_printers: 25,
      expires_at: EXPIRES_1,
      grace_days: 7,
      nowMs: T0,
    },
    privPem,
  );

  assert.equal(issued.payload.version, 2);
  assert.equal(issued.payload.status, "active");
  assert.equal(issued.payload.plan, "pro");
  assert.equal(issued.payload.max_printers, 25);
  assert.equal(issued.payload.odoo_db_uuid, "db-uuid-prod-01");
  assert.equal(issued.payload.expires_at, EXPIRES_1);
  assert.equal(issued.payload.grace_until, GRACE_1);
  assert.equal(issued.payload.rev, Math.floor(T0 / 1000));

  // 2. ACTIVATE: license key hash & DB UUID binding verification
  const rawKey = "ysk_live_activation_secret_key_01";
  const storedHash = signer.hashLicenseKey(rawKey);
  assert.equal(signer.constantTimeSecretMatch(storedHash, signer.hashLicenseKey(`  ${rawKey}  `)), true);
  assert.equal(signer.constantTimeSecretMatch(storedHash, signer.hashLicenseKey("wrong_key")), false);

  const activatedCheck = signer.verifyLicenseBundle(
    issued,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: 1 },
    T0 + 60_000,
  );
  assert.equal(activatedCheck.ok, true);
  assert.equal(activatedCheck.inGrace, false);

  // Wrong DB UUID must be rejected immediately
  const wrongDb = signer.verifyLicenseBundle(
    issued,
    pubPem,
    { expectedDbUuid: "db-uuid-cloned-staging", minRev: 1 },
    T0 + 60_000,
  );
  assert.equal(wrongDb.ok, false);
  assert.equal(wrongDb.reason, "db_uuid_mismatch");
  assert.equal(signer.licenseReasonToErrorCode(wrongDb.reason), "DB_UUID_MISMATCH");

  // 3. VALIDATE in grace period (past expires_at, within grace_until)
  const inGraceCheck = signer.verifyLicenseBundle(
    issued,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: issued.payload.rev },
    IN_GRACE_1,
  );
  assert.equal(inGraceCheck.ok, true);
  assert.equal(inGraceCheck.inGrace, true);

  // 4. EXPIRE: past grace_until -> clean license_expired transition
  const expiredCheck = signer.verifyLicenseBundle(
    issued,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: issued.payload.rev },
    AFTER_EXPIRE_1,
  );
  assert.equal(expiredCheck.ok, false);
  assert.equal(expiredCheck.reason, "license_expired");
  assert.equal(signer.licenseReasonToErrorCode(expiredCheck.reason), "LICENSE_EXPIRED");

  // 5. RENEW: bump rev strictly monotonically, extend expires_at & grace_until, clear prior expiry
  const renewed = signer.renewLicenseBundle(
    issued.payload,
    {
      expires_at: EXPIRES_2,
      grace_days: 7,
      max_printers: 50,
      nowMs: AFTER_EXPIRE_1,
    },
    privPem,
  );

  assert.equal(renewed.payload.status, "active");
  assert.ok(renewed.payload.rev > issued.payload.rev, "renewed rev must strictly exceed issued rev");
  assert.equal(renewed.payload.expires_at, EXPIRES_2);
  assert.equal(renewed.payload.grace_until, GRACE_2);
  assert.equal(renewed.payload.max_printers, 50);

  // Renewed bundle is valid at AFTER_EXPIRE_1 (prior expiry cleared cleanly)
  const renewedValid = signer.verifyLicenseBundle(
    renewed,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: renewed.payload.rev },
    AFTER_EXPIRE_1 + 1000,
  );
  assert.equal(renewedValid.ok, true);
  assert.equal(renewedValid.inGrace, false);

  // Anti-rollback: old bundle is rejected once minRev advances to renewed.payload.rev
  const rollbackOld = signer.verifyLicenseBundle(
    issued,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: renewed.payload.rev },
    T0 + 60_000,
  );
  assert.equal(rollbackOld.ok, false);
  assert.equal(rollbackOld.reason, "license_rollback");
  assert.equal(signer.licenseReasonToErrorCode(rollbackOld.reason), "LICENSE_ROLLBACK");

  // 6. REVOKE: signed revocation tombstone with strictly higher rev (even within the same second!)
  const tombstone = signer.revokeLicenseBundle(
    {
      license_id: renewed.payload.license_id,
      tenant_id: renewed.payload.tenant_id,
      odoo_db_uuid: renewed.payload.odoo_db_uuid,
      plan: renewed.payload.plan,
      key_id: renewed.payload.key_id,
      prev_rev: renewed.payload.rev,
      nowMs: AFTER_EXPIRE_1, // exact same millisecond as renewal
    },
    privPem,
  );

  assert.equal(tombstone.payload.status, "revoked");
  assert.equal(tombstone.payload.max_agents, 0);
  assert.equal(tombstone.payload.max_printers, 0);
  assert.deepEqual(tombstone.payload.features, []);
  assert.ok(
    tombstone.payload.rev > renewed.payload.rev,
    "revocation tombstone rev must strictly exceed renewed rev even within the same second",
  );

  // Verifying the tombstone fails closed with license_revoked
  const revokedRes = signer.verifyLicenseBundle(
    tombstone,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: renewed.payload.rev },
    AFTER_EXPIRE_1,
  );
  assert.equal(revokedRes.ok, false);
  assert.equal(revokedRes.reason, "license_revoked");
  assert.equal(signer.licenseReasonToErrorCode(revokedRes.reason), "LICENSE_REVOKED");

  // Advancing minRev to tombstone.payload.rev immediately invalidates the previously active renewed bundle
  const oldAfterRevoke = signer.verifyLicenseBundle(
    renewed,
    pubPem,
    { expectedDbUuid: "db-uuid-prod-01", minRev: tombstone.payload.rev },
    AFTER_EXPIRE_1 + 1000,
  );
  assert.equal(oldAfterRevoke.ok, false);
  assert.equal(oldAfterRevoke.reason, "license_rollback");
});

test("Same-second monotonic rev bump works for rapid issue -> renew -> revoke", () => {
  const b1 = signer.issueLicenseBundle(
    {
      license_id: "lic_fast",
      tenant_id: "ten_fast",
      odoo_db_uuid: "uuid-fast",
      plan: "starter",
      max_agents: 1,
      max_printers: 5,
      expires_at: EXPIRES_1,
      nowMs: T0,
    },
    privPem,
  );
  const b2 = signer.renewLicenseBundle(
    b1.payload,
    { expires_at: EXPIRES_2, nowMs: T0 },
    privPem,
  );
  const b3 = signer.revokeLicenseBundle(
    {
      license_id: b2.payload.license_id,
      tenant_id: b2.payload.tenant_id,
      odoo_db_uuid: b2.payload.odoo_db_uuid,
      plan: b2.payload.plan,
      prev_rev: b2.payload.rev,
      nowMs: T0,
    },
    privPem,
  );

  assert.equal(b2.payload.rev, b1.payload.rev + 1);
  assert.equal(b3.payload.rev, b2.payload.rev + 1);
});

test("Error states: invalid signature, wrong key, malformed encoding, invalid timestamps, non-extending renewal", () => {
  const bundle = signer.issueLicenseBundle(
    {
      license_id: "lic_err",
      tenant_id: "ten_err",
      odoo_db_uuid: "uuid-err",
      plan: "pro",
      max_agents: 2,
      max_printers: 10,
      expires_at: EXPIRES_1,
      nowMs: T0,
    },
    privPem,
  );

  // Wrong public key -> invalid_signature
  const wrongKeyRes = signer.verifyLicenseBundle(bundle, otherPubPem, { expectedDbUuid: "uuid-err" }, T0);
  assert.equal(wrongKeyRes.ok, false);
  assert.equal(wrongKeyRes.reason, "invalid_signature");
  assert.equal(signer.licenseReasonToErrorCode(wrongKeyRes.reason), "INVALID_SIGNATURE");

  // Non-base64url signature encoding -> invalid_signature_encoding
  const badEncRes = signer.verifyLicenseBundle(
    { ...bundle, signature: "not+valid/base64url==" },
    pubPem,
    { expectedDbUuid: "uuid-err" },
    T0,
  );
  assert.equal(badEncRes.ok, false);
  assert.equal(badEncRes.reason, "invalid_signature_encoding");

  // Truncated signature -> invalid_signature
  const shortSigRes = signer.verifyLicenseBundle(
    { ...bundle, signature: "AAAA" },
    pubPem,
    { expectedDbUuid: "uuid-err" },
    T0,
  );
  assert.equal(shortSigRes.ok, false);
  assert.equal(shortSigRes.reason, "invalid_signature");

  // Tampered payload -> invalid_signature
  const tamperedRes = signer.verifyLicenseBundle(
    { ...bundle, payload: { ...bundle.payload, max_printers: 9999 } },
    pubPem,
    { expectedDbUuid: "uuid-err" },
    T0,
  );
  assert.equal(tamperedRes.ok, false);
  assert.equal(tamperedRes.reason, "invalid_signature");

  // Invalid timestamps rejected at issue time
  assert.throws(() =>
    signer.issueLicenseBundle(
      {
        license_id: "lic_bad_time",
        tenant_id: "ten_err",
        odoo_db_uuid: "uuid-err",
        plan: "pro",
        max_agents: 1,
        max_printers: 5,
        issued_at: EXPIRES_1,
        expires_at: "2026-11-01T00:00:00.000Z",
        nowMs: T0,
      },
      privPem,
    ),
  );

  // Renewal that does not extend prior expires_at must throw
  assert.throws(() =>
    signer.renewLicenseBundle(
      bundle.payload,
      { expires_at: EXPIRES_1, nowMs: T0 },
      privPem,
    ),
  );

  // Error code mapping covers all API error states
  assert.equal(signer.licenseReasonToErrorCode("workspace_not_active"), "TENANT_SUSPENDED");
  assert.equal(signer.licenseReasonToErrorCode("no_active_subscription"), "NO_ACTIVE_SUBSCRIPTION");
  assert.equal(signer.licenseReasonToErrorCode("subscription_expired"), "LICENSE_EXPIRED");
  assert.equal(signer.licenseReasonToErrorCode("odoo_db_unbound"), "ODOO_DB_UNBOUND");
  assert.equal(signer.licenseReasonToErrorCode("tenant_mismatch"), "TENANT_MISMATCH");
});

test("License API routes enforce consistent error codes, rate limiting, and lifecycle handlers", () => {
  const root = process.cwd();
  const routes = [
    "src/app/api/license/activate/route.ts",
    "src/app/api/license/verify/route.ts",
    "src/app/api/license/refresh/route.ts",
    "src/app/api/license/revoke/route.ts",
  ];

  for (const rel of routes) {
    const full = path.join(root, rel);
    assert.equal(fs.existsSync(full), true, `Missing route: ${rel}`);
    const src = fs.readFileSync(full, "utf8");
    assert.ok(src.includes("hasBodyOverLimit(req, 16 * 1024)"), `${rel} must enforce 16KB body limit`);
    assert.ok(src.includes("MISSING_LICENSE_KEY"), `${rel} must return structured MISSING_LICENSE_KEY`);
    assert.ok(src.includes("INVALID_LICENSE_KEY"), `${rel} must return structured INVALID_LICENSE_KEY`);
    assert.ok(src.includes("RATE_LIMITED"), `${rel} must enforce rate limiting with RATE_LIMITED`);
    assert.ok(src.includes("status: 429"), `${rel} must return HTTP 429 when rate-limited`);
    assert.ok(src.includes("TENANT_MISMATCH"), `${rel} must isolate tenants with TENANT_MISMATCH`);
    assert.ok(src.includes("db.transaction("), `${rel} must execute inside db.transaction`);
  }

  // Verify route & auth guard invariants
  const proxySrc = fs.readFileSync(path.join(root, "proxy.ts"), "utf8");
  const nextCfg = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
  const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
  const pricingSrc = fs.readFileSync(path.join(root, "src/app/pricing/page.tsx"), "utf8");
  const billingSrc = fs.readFileSync(path.join(root, "src/app/billing/page.tsx"), "utf8");
  const dashboardSrc = fs.readFileSync(path.join(root, "src/app/dashboard/page.tsx"), "utf8");
  const onboardingSrc = fs.readFileSync(path.join(root, "src/app/onboarding/page.tsx"), "utf8");

  assert.ok(proxySrc.includes("NextResponse.next()"), "proxy.ts must remain a transparent pass-through for CSP");
  assert.ok(nextCfg.includes('source: "/platform"'), "next.config.ts must redirect /platform to /platform/login");
  assert.ok(serverSrc.includes('delete req.headers["x-middleware-subrequest"]'), "server.ts must strip x-middleware-subrequest");
  assert.ok(pricingSrc.includes("public catalog is readable without a session"), "/pricing must stay publicly accessible");
  assert.ok(billingSrc.includes('redirect("/login?next=%2Fbilling")'), "/billing must require valid auth");
  assert.ok(dashboardSrc.includes('redirect("/login")'), "/dashboard must require valid auth");
  assert.ok(onboardingSrc.includes("redirect(") && onboardingSrc.includes("/billing"), "/onboarding must route into auth-gated /billing");
});
