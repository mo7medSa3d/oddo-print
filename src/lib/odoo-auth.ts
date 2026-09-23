import { db } from "../db";
import { apiKeys } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { requireActiveTenant } from "./tenant-guard";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateOdooApiKey(): { raw: string; hashed: string; id: string } {
  const raw = `odoo_${randomBytes(32).toString("base64url")}`;
  return { raw, hashed: hashKey(raw), id: `key_${randomBytes(8).toString("hex")}` };
}

export async function validateOdooKey(
  req: Request,
  options: {
    requireIntegrationEnabled?: boolean;
    requireActiveTenant?: boolean;
  } = {},
) {
  // Odoo Gateway authentication is based on the Odoo installation API key.
  // The Odoo database name is not used as an authentication requirement:
  // X-Odoo-Database may be sent for informational purposes and is ignored.
  const authorization = req.headers.get("authorization") ?? "";
  const apiHeader = req.headers.get("x-api-key") ?? "";
  const raw = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : apiHeader.trim();
  if (!raw.startsWith("odoo_")) return null;

  const hashed = hashKey(raw);
  const row = await db.query.apiKeys.findFirst({ where: eq(apiKeys.hashedKey, hashed) });
  const now = new Date();
  const rotationGraceActive = Boolean(
    row?.revokedAt &&
    row.readOnlyUntil &&
    new Date(row.readOnlyUntil).getTime() > now.getTime(),
  );
  if (
    !row ||
    !timingSafeEqualStr(row.hashedKey, hashed) ||
    (row.revokedAt && !rotationGraceActive) ||
    (!row.revokedAt && row.readOnlyUntil)
  ) return null;

  await db.update(apiKeys).set({ lastUsedAt: now }).where(and(eq(apiKeys.id, row.id), eq(apiKeys.tenantId, row.tenantId))).catch(() => undefined);
  // Tenant lifecycle gate: suspended/deleted tenants cannot perform normal
  // Odoo operations. Health probes may opt out so the caller can return the
  // correct 403 lifecycle status instead of misclassifying it as bad credentials.
  if (options.requireActiveTenant !== false) {
    try {
      await requireActiveTenant(row.tenantId);
    } catch {
      return null;
    }
  }
  // Credential validity and integration activation are deliberately separate.
  // Configuration/health must remain callable while this integration is disabled
  // so the same authenticated credential can re-enable it.
  if (options.requireIntegrationEnabled !== false && !row.odooEnabled) return null;

  return { ...row, readOnly: rotationGraceActive };
}
