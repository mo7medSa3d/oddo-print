import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from "node:crypto";

export type LicenseStatus = "active" | "revoked";
export type Ed25519KeyObject = ReturnType<typeof createPublicKey>;
export type Ed25519KeyCache = Map<string, Ed25519KeyObject>;

const MAX_CACHED_KEYS = 16;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SIGNATURE_B64URL_LEN = 86;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const privateKeyCache: Ed25519KeyCache = new Map();
const publicKeyCache: Ed25519KeyCache = new Map();

function cacheKey(cache: Ed25519KeyCache, pem: string, key: Ed25519KeyObject): Ed25519KeyObject {
  if (cache.size >= MAX_CACHED_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(pem, key);
  return key;
}

function getPrivateKey(privateKeyPem: string): Ed25519KeyObject {
  if (typeof privateKeyPem !== "string" || !privateKeyPem.trim()) {
    throw new Error("Ed25519 private key required");
  }
  const cached = privateKeyCache.get(privateKeyPem);
  if (cached) return cached;
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Ed25519 private key required");
  }
  return cacheKey(privateKeyCache, privateKeyPem, key);
}

function getPublicKey(publicKeyPem: string): Ed25519KeyObject {
  const cached = publicKeyCache.get(publicKeyPem);
  if (cached) return cached;
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Ed25519 public key required");
  }
  return cacheKey(publicKeyCache, publicKeyPem, key);
}

export interface LicenseClaimsV1 {
  version: 1;
  license_id: string;
  tenant_id: string;
  odoo_db_uuid: string;
  plan: string;
  max_agents: number;
  max_printers: number;
  issued_at: string;
  expires_at: string;
  grace_until: string;
}

export interface LicenseClaimsV2 {
  version: 2;
  license_id: string;
  tenant_id: string;
  odoo_db_uuid: string;
  plan: string;
  status: LicenseStatus;
  rev: number;
  key_id: string;
  max_agents: number;
  max_printers: number;
  features: string[];
  issued_at: string;
  expires_at: string;
  grace_until: string;
}

export type LicenseClaims = LicenseClaimsV1 | LicenseClaimsV2;

export interface SignedLicenseBundle<T extends LicenseClaims = LicenseClaims> {
  payload: T;
  signature: string;
}

export interface VerifyLicenseOptions {
  expectedDbUuid?: string;
  minRev?: number;
}

export interface IssueLicenseParams {
  license_id: string;
  tenant_id: string;
  odoo_db_uuid: string;
  plan?: string;
  plan_id?: string;
  key_id?: string;
  max_agents: number;
  max_printers: number;
  features?: string[];
  issued_at?: string;
  expires_at: string;
  grace_until?: string;
  grace_days?: number;
  rev?: number;
  prev_rev?: number;
  nowMs?: number;
}

export interface RenewLicenseParams {
  expires_at: string;
  grace_until?: string;
  grace_days?: number;
  plan?: string;
  plan_id?: string;
  key_id?: string;
  max_agents?: number;
  max_printers?: number;
  features?: string[];
  nowMs?: number;
}

export interface RevokeLicenseParams {
  license_id: string;
  tenant_id: string;
  odoo_db_uuid: string;
  plan?: string;
  plan_id?: string;
  key_id?: string;
  prev_rev?: number;
  nowMs?: number;
}

/** Canonical byte representation shared across Node (signer), Go, and Python (verifiers). */
export function canonicalLicensePayloadBytes(claims: LicenseClaims): Buffer {
  if (claims.version === 2) {
    const orderedV2 = {
      expires_at: claims.expires_at,
      features: claims.features,
      grace_until: claims.grace_until,
      issued_at: claims.issued_at,
      key_id: claims.key_id,
      license_id: claims.license_id,
      max_agents: claims.max_agents,
      max_printers: claims.max_printers,
      odoo_db_uuid: claims.odoo_db_uuid,
      plan: claims.plan,
      rev: claims.rev,
      status: claims.status,
      tenant_id: claims.tenant_id,
      version: claims.version,
    };
    return Buffer.from(JSON.stringify(orderedV2), "utf8");
  }

  const orderedV1 = {
    expires_at: claims.expires_at,
    grace_until: claims.grace_until,
    issued_at: claims.issued_at,
    license_id: claims.license_id,
    max_agents: claims.max_agents,
    max_printers: claims.max_printers,
    odoo_db_uuid: claims.odoo_db_uuid,
    plan: claims.plan,
    tenant_id: claims.tenant_id,
    version: claims.version,
  };
  return Buffer.from(JSON.stringify(orderedV1), "utf8");
}

export function signLicenseBundle<T extends LicenseClaims>(
  claims: T,
  privateKeyPem: string,
): SignedLicenseBundle<T> {
  const key = getPrivateKey(privateKeyPem);
  const sig = sign(null, canonicalLicensePayloadBytes(claims), key).toString("base64url");
  return { payload: claims, signature: sig };
}

/** Strictly monotonic revision counter (epoch seconds, always > prevRev). */
export function nextLicenseRev(nowMs = Date.now(), prevRev = 0): number {
  const floorSec = Number.isFinite(nowMs) ? Math.floor(nowMs / 1000) : Math.floor(Date.now() / 1000);
  const safePrev = typeof prevRev === "number" && Number.isSafeInteger(prevRev) && prevRev > 0 ? prevRev : 0;
  return Math.max(1, floorSec, safePrev + 1);
}

export function issueLicenseBundle(
  params: IssueLicenseParams,
  privateKeyPem: string,
): SignedLicenseBundle<LicenseClaimsV2> {
  const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const issuedIso = params.issued_at ?? new Date(nowMs).toISOString();
  const issuedMs = Date.parse(issuedIso);
  const expiresMs = Date.parse(params.expires_at);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs < issuedMs) {
    throw new Error("Invalid license timestamps");
  }
  const graceDays = typeof params.grace_days === "number" && Number.isFinite(params.grace_days) && params.grace_days >= 0
    ? params.grace_days
    : 7;
  const graceIso = params.grace_until ?? new Date(expiresMs + graceDays * 86400_000).toISOString();
  const graceMs = Date.parse(graceIso);
  if (!Number.isFinite(graceMs) || graceMs < expiresMs) {
    throw new Error("Invalid license grace_until timestamp");
  }
  const plan = (params.plan ?? params.plan_id ?? "").trim();
  const rev = typeof params.rev === "number" && Number.isSafeInteger(params.rev) && params.rev > 0
    ? params.rev
    : nextLicenseRev(nowMs, params.prev_rev ?? 0);
  const claims: LicenseClaimsV2 = {
    version: 2,
    license_id: params.license_id.trim(),
    tenant_id: params.tenant_id.trim(),
    odoo_db_uuid: params.odoo_db_uuid.trim(),
    plan,
    status: "active",
    rev,
    key_id: (params.key_id ?? "k1").trim() || "k1",
    max_agents: params.max_agents,
    max_printers: params.max_printers,
    features: Array.isArray(params.features) ? [...params.features] : ["direct_print", "ws_push"],
    issued_at: issuedIso,
    expires_at: new Date(expiresMs).toISOString(),
    grace_until: new Date(graceMs).toISOString(),
  };
  if (!isValidBaseShape(claims) || !isValidV2Shape(claims)) {
    throw new Error("Invalid license claims");
  }
  return signLicenseBundle(claims, privateKeyPem);
}

export function renewLicenseBundle(
  existing: LicenseClaimsV2,
  params: RenewLicenseParams,
  privateKeyPem: string,
): SignedLicenseBundle<LicenseClaimsV2> {
  if (!existing || existing.version !== 2 || !isValidBaseShape(existing) || !isValidV2Shape(existing)) {
    throw new Error("Valid existing v2 license claims required for renewal");
  }
  const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const prevExpiresMs = Date.parse(existing.expires_at);
  const nextExpiresMs = Date.parse(params.expires_at);
  if (!Number.isFinite(nextExpiresMs) || nextExpiresMs < nowMs) {
    throw new Error("Renewal expires_at must be a valid future timestamp");
  }
  if (Number.isFinite(prevExpiresMs) && nextExpiresMs <= prevExpiresMs) {
    throw new Error("Renewal expires_at must extend prior expires_at");
  }
  return issueLicenseBundle(
    {
      license_id: existing.license_id,
      tenant_id: existing.tenant_id,
      odoo_db_uuid: existing.odoo_db_uuid,
      plan: params.plan ?? params.plan_id ?? existing.plan,
      key_id: params.key_id ?? existing.key_id,
      max_agents: params.max_agents ?? existing.max_agents,
      max_printers: params.max_printers ?? existing.max_printers,
      features: params.features ?? existing.features,
      issued_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nextExpiresMs).toISOString(),
      grace_until: params.grace_until,
      grace_days: params.grace_days,
      prev_rev: existing.rev,
      nowMs,
    },
    privateKeyPem,
  );
}

export function revokeLicenseBundle(
  params: RevokeLicenseParams,
  privateKeyPem: string,
): SignedLicenseBundle<LicenseClaimsV2> {
  const nowMs = typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const plan = (params.plan ?? params.plan_id ?? "none").trim() || "none";
  const claims: LicenseClaimsV2 = {
    version: 2,
    license_id: params.license_id.trim(),
    tenant_id: params.tenant_id.trim(),
    odoo_db_uuid: params.odoo_db_uuid.trim(),
    plan,
    status: "revoked",
    rev: nextLicenseRev(nowMs, params.prev_rev ?? 0),
    key_id: (params.key_id ?? "k1").trim() || "k1",
    max_agents: 0,
    max_printers: 0,
    features: [],
    issued_at: nowIso,
    expires_at: nowIso,
    grace_until: nowIso,
  };
  if (!isValidBaseShape(claims) || !isValidV2Shape(claims)) {
    throw new Error("Invalid revocation claims");
  }
  return signLicenseBundle(claims, privateKeyPem);
}

/** Map internal verification reason strings to consistent structured API error codes. */
export function licenseReasonToErrorCode(reason: string): string {
  switch (reason) {
    case "invalid_bundle": return "INVALID_BUNDLE";
    case "invalid_public_key": return "INVALID_PUBLIC_KEY";
    case "invalid_signature_encoding": return "INVALID_SIGNATURE_ENCODING";
    case "invalid_signature": return "INVALID_SIGNATURE";
    case "db_uuid_mismatch": return "DB_UUID_MISMATCH";
    case "license_revoked": return "LICENSE_REVOKED";
    case "license_rollback": return "LICENSE_ROLLBACK";
    case "invalid_timestamps": return "INVALID_TIMESTAMPS";
    case "license_expired": return "LICENSE_EXPIRED";
    case "subscription_expired": return "LICENSE_EXPIRED";
    case "workspace_not_active": return "TENANT_SUSPENDED";
    case "no_active_subscription": return "NO_ACTIVE_SUBSCRIPTION";
    case "odoo_db_unbound": return "ODOO_DB_UNBOUND";
    case "tenant_mismatch": return "TENANT_MISMATCH";
    default: return "LICENSE_INVALID";
  }
}

function isValidBaseShape(payload: LicenseClaims): boolean {
  return (
    typeof payload.license_id === "string" &&
    payload.license_id.trim().length > 0 &&
    typeof payload.tenant_id === "string" &&
    payload.tenant_id.trim().length > 0 &&
    typeof payload.odoo_db_uuid === "string" &&
    payload.odoo_db_uuid.trim().length > 0 &&
    typeof payload.plan === "string" &&
    payload.plan.trim().length > 0 &&
    typeof payload.max_agents === "number" &&
    Number.isSafeInteger(payload.max_agents) &&
    payload.max_agents >= 0 &&
    typeof payload.max_printers === "number" &&
    Number.isSafeInteger(payload.max_printers) &&
    payload.max_printers >= 0 &&
    typeof payload.issued_at === "string" &&
    payload.issued_at.length > 0 &&
    typeof payload.expires_at === "string" &&
    payload.expires_at.length > 0 &&
    typeof payload.grace_until === "string" &&
    payload.grace_until.length > 0
  );
}

function isValidV2Shape(payload: LicenseClaimsV2): boolean {
  return (
    (payload.status === "active" || payload.status === "revoked") &&
    typeof payload.rev === "number" &&
    Number.isSafeInteger(payload.rev) &&
    payload.rev > 0 &&
    typeof payload.key_id === "string" &&
    payload.key_id.trim().length > 0 &&
    Array.isArray(payload.features) &&
    payload.features.every((f) => typeof f === "string")
  );
}

export function verifyLicenseBundle(
  bundle: SignedLicenseBundle,
  publicKeyPem: string,
  optsOrExpectedDbUuid?: string | VerifyLicenseOptions,
  nowMs = Date.now(),
): { ok: true; claims: LicenseClaims; inGrace: boolean } | { ok: false; reason: string } {
  if (
    !bundle ||
    typeof bundle !== "object" ||
    Array.isArray(bundle) ||
    !bundle.payload ||
    typeof bundle.payload !== "object" ||
    Array.isArray(bundle.payload) ||
    typeof bundle.signature !== "string" ||
    (bundle.payload.version !== 1 && bundle.payload.version !== 2) ||
    !isValidBaseShape(bundle.payload)
  ) {
    return { ok: false, reason: "invalid_bundle" };
  }
  if (bundle.payload.version === 2 && !isValidV2Shape(bundle.payload)) {
    return { ok: false, reason: "invalid_bundle" };
  }

  const opts: VerifyLicenseOptions =
    typeof optsOrExpectedDbUuid === "string"
      ? { expectedDbUuid: optsOrExpectedDbUuid }
      : (optsOrExpectedDbUuid ?? {});

  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) {
    return { ok: false, reason: "invalid_public_key" };
  }
  if (!bundle.signature || !BASE64URL_RE.test(bundle.signature)) {
    return { ok: false, reason: "invalid_signature_encoding" };
  }
  // Reject non-64-byte signatures before Buffer decode or OpenSSL (unpadded base64url is always 86 chars).
  if (bundle.signature.length !== ED25519_SIGNATURE_B64URL_LEN) {
    return { ok: false, reason: "invalid_signature" };
  }
  const sigBuf = Buffer.from(bundle.signature, "base64url");
  if (sigBuf.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: "invalid_signature" };
  }

  let validSig = false;
  try {
    const key = getPublicKey(publicKeyPem);
    try {
      validSig = verify(null, canonicalLicensePayloadBytes(bundle.payload), key, sigBuf);
    } catch {
      return { ok: false, reason: "invalid_signature" };
    }
  } catch {
    return { ok: false, reason: "invalid_public_key" };
  }
  if (!validSig) return { ok: false, reason: "invalid_signature" };

  if (opts.expectedDbUuid && bundle.payload.odoo_db_uuid !== opts.expectedDbUuid) {
    return { ok: false, reason: "db_uuid_mismatch" };
  }

  if (bundle.payload.version === 2 && bundle.payload.status === "revoked") {
    return { ok: false, reason: "license_revoked" };
  }

  if (typeof opts.minRev === "number" && Number.isFinite(opts.minRev)) {
    const rev = bundle.payload.version === 2 ? bundle.payload.rev : 0;
    if (rev < opts.minRev) {
      return { ok: false, reason: "license_rollback" };
    }
  }

  const issuedMs = Date.parse(bundle.payload.issued_at);
  const expiresMs = Date.parse(bundle.payload.expires_at);
  const graceMs = Date.parse(bundle.payload.grace_until);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(issuedMs) ||
    !Number.isFinite(expiresMs) ||
    !Number.isFinite(graceMs) ||
    expiresMs < issuedMs ||
    graceMs < expiresMs
  ) {
    return { ok: false, reason: "invalid_timestamps" };
  }
  if (nowMs > graceMs) {
    return { ok: false, reason: "license_expired" };
  }
  return { ok: true, claims: bundle.payload, inGrace: nowMs > expiresMs };
}

export function hashLicenseKey(rawKey: string): string {
  return createHash("sha256").update(rawKey.trim(), "utf8").digest("hex");
}

export function constantTimeSecretMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
