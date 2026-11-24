import { createHash } from "node:crypto";

/** Historical v1 wire contract: changing these bytes can physically reprint a job. */
export function makeLegacyOdooKey(companyId: string, operationId: string): string {
  return createHash("sha256").update(`odoo:${companyId}:${operationId}`).digest("hex");
}

/** v2 has its own unambiguous domain and the Gateway-enrolled installation UUID. */
export function makeV2OdooKey(installationId: string, companyId: string, operationId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["yaseir-odoo-v2", installationId, companyId, operationId]))
    .digest("hex");
}

export type V2OdooIdentity = {
  version: 2;
  installationId: string;
  installationProof: string;
  sourceCompanyId: string;
  sourceOperationId: string;
  legacyKey: string;
  key: string;
};

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Match the lower-case, RFC 4122 UUIDv4 that Odoo persists in its own enrollment proof. */
export function isCanonicalOdooV2InstallationId(value: unknown): value is string {
  return typeof value === "string" && uuidV4.test(value);
}
const proofPattern = /^[A-Za-z0-9_-]{43}$/;

/**
 * V2 source operation IDs are UTF-16 length bounded in Gateway and must be
 * encodable as valid Unicode by Python Odoo. Reject isolated high/low
 * surrogates before hashing: JSON.stringify would otherwise escape them and
 * make an identity the upstream outbox cannot produce.
 *
 * Keep the immutable legacy v1 hash contract separate from this predicate.
 */
export function isValidOdooV2OperationId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  for (let i = 0; i < value.length; i++) {
    const point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Pure input contract; the DB validates live proof, enrollment and credential in the enqueue transaction. */
export function parseOdooIdentity(input: {
  idempotencyVersion?: number;
  installationId?: string;
  installationProof?: string;
  sourceCompanyId?: string;
  sourceOperationId?: string;
  idempotencyKey?: string;
}): V2OdooIdentity | null {
  if (input.idempotencyVersion === undefined || input.idempotencyVersion === 1) return null;
  if (input.idempotencyVersion !== 2) throw new Error("UNSUPPORTED_IDEMPOTENCY_VERSION");
  const installationId = input.installationId ?? "";
  const proof = input.installationProof ?? "";
  const company = input.sourceCompanyId ?? "";
  const operation = input.sourceOperationId ?? "";
  if (!isCanonicalOdooV2InstallationId(installationId) || !proofPattern.test(proof) ||
      !/^[1-9][0-9]{0,17}$/.test(company) || !isValidOdooV2OperationId(operation)) {
    throw new Error("INVALID_INSTALLATION_IDENTITY");
  }
  const key = makeV2OdooKey(installationId, company, operation);
  if (input.idempotencyKey !== key) throw new Error("INVALID_INSTALLATION_IDEMPOTENCY_KEY");
  return {
    version: 2, installationId, installationProof: proof,
    sourceCompanyId: company, sourceOperationId: operation,
    legacyKey: makeLegacyOdooKey(company, operation), key,
  };
}

/** A similar document fingerprint is not evidence of a common business owner. */
export function classifyLegacyCollision(
  hasLegacyHistory: boolean,
  operatorResolution: "reuse" | "distinct" | null,
): "clear" | "reuse" | "distinct" | "RECONCILIATION_REQUIRED" {
  if (!hasLegacyHistory) return "clear";
  return operatorResolution ?? "RECONCILIATION_REQUIRED";
}
