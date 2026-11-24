import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load the real `src/lib/license-signer.ts` directly in Node >= 18 without a
 * TypeScript transpiler dependency by stripping only static type annotations.
 */
async function loadRealLicenseSigner() {
  const srcPath = path.resolve(process.cwd(), "src/lib/license-signer.ts");
  let src = fs.readFileSync(srcPath, "utf8");

  // Remove exported type aliases and interfaces.
  src = src.replace(/^export\s+type\s+[^;]+;\s*$/gm, "");
  src = src.replace(/^export\s+interface\s+\w+(?:<[^>]+>)?\s*\{[\s\S]*?^\}\s*$/gm, "");

  // Remove variable type annotations (`const x: Type =`, `let x: Type;`).
  src = src.replace(/\b(const|let)\s+(\w+)\s*:\s*[A-Za-z0-9_<>|\[\]\s]+?(\s*[=;])/g, "$1 $2$3");

  // Strip generics, parameter types, and return types strictly on function headers
  // so object literals like `{ payload: claims, signature: sig }` are untouched.
  src = src.replace(
    /((?:export\s+)?function\s+\w+)(?:\s*<[^>]+>)?\s*\(([\s\S]*?)\)\s*:\s*(?:\{[^\n]+\}(?:\s*\|\s*\{[^\n]+\})?|[A-Za-z0-9_<>|\[\]]+)\s*\{/g,
    (_match, fnHead, rawParams) => {
      const cleanParams = rawParams.replace(
        /(\b\w+)\??\s*:\s*[^,=)]+/g,
        "$1",
      );
      return `${fnHead}(${cleanParams}) {`;
    },
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "license-signer-test-"));
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

const BASE_NOW = Date.parse("2026-11-17T06:00:00Z");
const IN_GRACE_NOW = Date.parse("2026-12-03T00:00:00Z");
const EXPIRED_NOW = Date.parse("2026-12-09T00:00:00Z");

const V1_CLAIMS = {
  version: 1,
  license_id: "sub_01",
  tenant_id: "ten_01",
  odoo_db_uuid: "uuid-odoo-19",
  plan: "pro",
  max_agents: 5,
  max_printers: 20,
  issued_at: "2026-11-17T00:00:00Z",
  expires_at: "2026-12-01T00:00:00Z",
  grace_until: "2026-12-08T00:00:00Z",
};

const V2_CLAIMS = {
  version: 2,
  license_id: "sub_02",
  tenant_id: "ten_01",
  odoo_db_uuid: "uuid-odoo-19",
  plan: "pro",
  status: "active",
  rev: 5,
  key_id: "key-2026-11",
  max_agents: 5,
  max_printers: 20,
  features: ["direct_ws", "pos_receipt"],
  issued_at: "2026-11-17T00:00:00Z",
  expires_at: "2026-12-01T00:00:00Z",
  grace_until: "2026-12-08T00:00:00Z",
};

test("Ed25519 v1 bundle signs, verifies, detects tampering, and enforces grace/expiry", () => {
  const bundle = signer.signLicenseBundle(V1_CLAIMS, privPem);

  const ok = signer.verifyLicenseBundle(bundle, pubPem, "uuid-odoo-19", BASE_NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.inGrace, false);
  assert.equal(ok.claims.license_id, "sub_01");

  const tampered = { ...bundle, payload: { ...bundle.payload, max_printers: 999 } };
  const tamperedRes = signer.verifyLicenseBundle(tampered, pubPem, "uuid-odoo-19", BASE_NOW);
  assert.equal(tamperedRes.ok, false);
  assert.equal(tamperedRes.reason, "invalid_signature");

  const mismatch = signer.verifyLicenseBundle(bundle, pubPem, "uuid-other-db", BASE_NOW);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "db_uuid_mismatch");

  const grace = signer.verifyLicenseBundle(bundle, pubPem, "uuid-odoo-19", IN_GRACE_NOW);
  assert.equal(grace.ok, true);
  assert.equal(grace.inGrace, true);

  const expired = signer.verifyLicenseBundle(bundle, pubPem, "uuid-odoo-19", EXPIRED_NOW);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "license_expired");
});

test("Ed25519 v2 bundle signs, verifies, enforces status=revoked, minRev anti-rollback, grace, and expiry", () => {
  const bundle = signer.signLicenseBundle(V2_CLAIMS, privPem);

  // Active v2 happy path
  const ok = signer.verifyLicenseBundle(
    bundle,
    pubPem,
    { expectedDbUuid: "uuid-odoo-19", minRev: 5 },
    BASE_NOW,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.inGrace, false);
  assert.equal(ok.claims.version, 2);
  assert.equal(ok.claims.rev, 5);

  // Tamper rev field
  const tampered = { ...bundle, payload: { ...bundle.payload, rev: 99 } };
  const tamperedRes = signer.verifyLicenseBundle(tampered, pubPem, { expectedDbUuid: "uuid-odoo-19" }, BASE_NOW);
  assert.equal(tamperedRes.ok, false);
  assert.equal(tamperedRes.reason, "invalid_signature");

  // odoo_db_uuid mismatch
  const mismatch = signer.verifyLicenseBundle(bundle, pubPem, { expectedDbUuid: "uuid-wrong" }, BASE_NOW);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "db_uuid_mismatch");

  // minRev anti-rollback rejection
  const rollback = signer.verifyLicenseBundle(
    bundle,
    pubPem,
    { expectedDbUuid: "uuid-odoo-19", minRev: 6 },
    BASE_NOW,
  );
  assert.equal(rollback.ok, false);
  assert.equal(rollback.reason, "license_rollback");

  // Revoked tombstone rejection
  const revokedBundle = signer.signLicenseBundle({ ...V2_CLAIMS, rev: 6, status: "revoked" }, privPem);
  const revokedRes = signer.verifyLicenseBundle(
    revokedBundle,
    pubPem,
    { expectedDbUuid: "uuid-odoo-19", minRev: 5 },
    BASE_NOW,
  );
  assert.equal(revokedRes.ok, false);
  assert.equal(revokedRes.reason, "license_revoked");

  // Grace period & expiry
  const grace = signer.verifyLicenseBundle(bundle, pubPem, { expectedDbUuid: "uuid-odoo-19" }, IN_GRACE_NOW);
  assert.equal(grace.ok, true);
  assert.equal(grace.inGrace, true);

  const expired = signer.verifyLicenseBundle(bundle, pubPem, { expectedDbUuid: "uuid-odoo-19" }, EXPIRED_NOW);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "license_expired");

  // SHA-256 license key hashing
  const hash = signer.hashLicenseKey("  lic_abc  ");
  assert.equal(hash.length, 64);
  assert.equal(hash, signer.hashLicenseKey("lic_abc"));
});

test("signLicenseBundle and verifyLicenseBundle fail closed on missing or invalid keys", () => {
  assert.throws(() => signer.signLicenseBundle(V2_CLAIMS, ""));
  assert.throws(() => signer.signLicenseBundle(V2_CLAIMS, "not-a-valid-pem"));

  const bundle = signer.signLicenseBundle(V2_CLAIMS, privPem);
  for (const badPub of ["", "   ", "not-a-valid-pem", null, undefined]) {
    const res = signer.verifyLicenseBundle(bundle, badPub, { expectedDbUuid: "uuid-odoo-19" }, BASE_NOW);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "invalid_public_key");
  }
});
