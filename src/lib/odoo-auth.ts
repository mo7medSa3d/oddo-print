import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
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

function normalizeDocumentType(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isOdooKeyAllowedForDocumentType(
  key: { allowedDocumentTypes?: string[] | null; scope?: string | null },
  documentType?: string | null,
  operation: "read" | "write" = "read",
): boolean {
  if (operation === "write" && String(key.scope ?? "standard").trim().toLowerCase() === "read_only") {
    return false;
  }
  const allowed = key.allowedDocumentTypes;
  if (!allowed || allowed.length === 0) return true;
  const normalized = normalizeDocumentType(documentType);
  if (!normalized) return false;
  return allowed.some((value) => normalizeDocumentType(value) === normalized);
}

export async function validateOdooKey(req: Request) {
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
  if (!row || row.revokedAt || !timingSafeEqualStr(row.hashedKey, hashed)) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(and(eq(apiKeys.id, row.id), eq(apiKeys.tenantId, row.tenantId))).catch(() => undefined);
  // Tenant lifecycle gate: suspended/deleted tenants cannot submit jobs via Odoo.
  try {
    await requireActiveTenant(row.tenantId);
  } catch {
    return null;
  }
  // Odoo integration gate: the tenant may have the integration disabled via the
  // /api/odoo/configuration toggle while still having valid, un-revoked keys.
  // Treat a disabled integration as auth failure (null → 401) to avoid leaking
  // whether the rejection is key-based or integration-based.
  const tenantRow = await db.query.tenants.findFirst({
    where: eq(tenants.id, row.tenantId),
    columns: { odooEnabled: true },
  });
  if (!tenantRow?.odooEnabled) return null;

  return row;
}
