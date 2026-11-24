import { createHmac, timingSafeEqual } from "node:crypto";
import { requiredRuntimeSecret, runtimeSecret } from "./runtime-secret";

function signingSecret() {
  const secret = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (secret.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return secret;
}

/** Internal snapshot of the exact verifier that succeeded; never a JWT claim. */
export function credentialVersionFor(userId: string, passwordHash: string): string {
  return createHmac("sha256", signingSecret()).update("session-credential-v1\0").update(userId).update("\0").update(passwordHash).digest("hex");
}

/** Preserve only the explicitly supported nonproduction environment-manager
 * policy. A real password check must precede use of this snapshot at issuance. */
export function environmentManagerCredentialVersion(tenantId: string): string | null {
  if ((process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") || process.env.ALLOW_LEGACY_MANAGER_AUTH !== "1") return null;
  const tenant = runtimeSecret("MANAGER_TENANT_ID")?.trim();
  const username = runtimeSecret("MANAGER_USERNAME");
  const hash = runtimeSecret("MANAGER_PASSWORD_HASH");
  const plaintext = runtimeSecret("MANAGER_PASSWORD");
  if (!tenant || tenant !== tenantId || !username) return null;
  let verifier: string;
  if (hash?.includes(":")) {
    const [salt, digest] = hash.split(":");
    if (!salt || !digest || !/^[0-9a-fA-F]{64}$/.test(digest)) return null;
    verifier = `scrypt:${hash}`;
  } else {
    if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !plaintext) return null;
    verifier = `development-plaintext:${plaintext}`;
  }
  return createHmac("sha256", signingSecret()).update("workspace-environment-credential-v1\0")
    .update(JSON.stringify([tenant, username, verifier])).digest("hex");
}

export function sameCredentialVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b)
    && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
