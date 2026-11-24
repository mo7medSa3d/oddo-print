import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// A deterministic database clock and a synthetic account that has already
// passed password verification. These offline transaction
// tests execute the production session policy and credential binding; only SQL storage and the
// configured nonproduction account are fixtures. Real issuance/login/expiry
// transactions are covered by workspace-session-security.integration.test.ts.
export const WORKSPACE_FIXTURE_NOW_MS = Date.UTC(2026, 0, 1);
const PASSWORD_HASH = 'synthetic-already-verified-password-hash';
export const sqlIdentifier = (name) => '"' + String(name).replaceAll('"', '""') + '"';

export async function workspaceSessionFixture(context, drizzle) {
  context.Buffer = Buffer;
  context.Response = Response;
  context.URL = URL;
  context.process = { env: {
    NODE_ENV: 'test',
    GATEWAY_JWT_SECRET: 'synthetic-offline-workspace-signing-key-48-characters',
    APP_BASE_URL: 'https://workspace-fixture.example.test',
    ALLOW_LEGACY_MANAGER_AUTH: '1',
    ALLOW_PLAINTEXT_MANAGER_PASSWORD: '1',
    MANAGER_TENANT_ID: 'tenant',
    MANAGER_USERNAME: 'fixture-manager',
    MANAGER_PASSWORD: 'synthetic-environment-manager-password',
  } };
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  const productionModule = (name) => new vm.SourceTextModule(stripTypeScriptTypes(
    readFileSync(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8'),
    { mode: 'transform' },
  ), { context, identifier: `production:${name}` });
  const unexpected = (name) => { throw new Error(`Unmapped workspace fixture import ${name}`); };
  const runtime = productionModule('runtime-secret');
  const files = synthetic({ readFileSync, statSync });
  await runtime.link((name) => name === 'node:fs' ? files : unexpected(name));
  await runtime.evaluate();
  const credentials = productionModule('session-credentials');
  const crypto = synthetic({ createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual });
  await credentials.link((name) => name === 'node:crypto' ? crypto : name === './runtime-secret' ? runtime : unexpected(name));
  await credentials.evaluate();
  const policy = productionModule('workspace-session-security');
  const database = synthetic({ db: { execute() { throw new Error('Policy must use the caller transaction'); } } });
  await policy.link((name) => name === 'drizzle-orm' ? drizzle : name === '../db' ? database : name === './session-credentials' ? credentials
    : unexpected(name));
  await policy.evaluate();

  function reply(text, claims, options = {}) {
    if (/FROM workspace_session_security s/.test(text)) {
      // Keep the fixture honest about the exact-session and clock fences the
      // production SQL must apply before returning the synthetic proof row.
      for (const predicate of [
        /s\.family_id\s*=/, /s\.kind\s*=/, /s\.tenant_id\s*=/,
        /r\.id\s*=/, /r\.role\s*=/, /r\.revoked_at IS NULL/,
        /s\.last_seen_at>clock_timestamp\(\)-interval '30 minutes'/,
        /s\.expires_at>clock_timestamp\(\)/, /FOR UPDATE OF s/,

      ]) assert.match(text, predicate);
      if (options.missingProof || options.idleExpired || (!claims.userId && (claims.kind !== 'manager' || claims.role !== 'owner'))) return { rows: [] };
      const credentialVersion = claims.userId
        ? credentials.namespace.credentialVersionFor(claims.userId, PASSWORD_HASH)
        : credentials.namespace.environmentManagerCredentialVersion(claims.tenantId);
      return { rows: [{
        familyId: claims.familyId, kind: claims.kind, tenantId: claims.tenantId,
        userId: claims.userId ?? null, verified: true, passwordHash: claims.userId ? PASSWORD_HASH : null,
        credentialVersion: options.changedCredential ? '0'.repeat(64) : credentialVersion,
        createdAtMs: WORKSPACE_FIXTURE_NOW_MS - 60_000,
        passwordVerifiedAtMs: WORKSPACE_FIXTURE_NOW_MS - (options.staleProof ? policy.namespace.WORKSPACE_LOGIN_PROOF_WINDOW_MS : 1_000),
        lastSeenAtMs: WORKSPACE_FIXTURE_NOW_MS - 1_000,
        expiresAtMs: WORKSPACE_FIXTURE_NOW_MS + 3_600_000,
        nowMs: WORKSPACE_FIXTURE_NOW_MS,
      }] };
    }
    if (/UPDATE workspace_session_security SET last_seen_at=/.test(text)) {
      options.onTouch?.();
      return { rows: options.touchExpired ? [] : [{ now_ms: WORKSPACE_FIXTURE_NOW_MS }] };
    }
    return undefined;
  }
  return { policy, reply };
}
