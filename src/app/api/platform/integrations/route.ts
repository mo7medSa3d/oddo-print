import { NextResponse } from "next/server";
import { and, desc, eq, gt, ilike, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../../db";
import { apiKeys, odooInstallationCredentials, odooInstallations, tenants } from "../../../../db/schema";
import { queryWithTimeout } from "../../../../db/client";
import { parseStrictListOffset } from "../../../../lib/request-limits";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction, PlatformUnauthorizedError } from "../../../../lib/platform-auth";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };

/** Metadata-only gateway integration inventory: NEVER select API-key hashes or installation secret hashes. */
export async function GET(req: Request) {
  let actor;
  try { actor = await requirePlatformOwner(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform authentication temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
  const p = new URL(req.url).searchParams;
  const kind = p.get("kind") ?? "keys";
  const status = p.get("status") ?? "all";
  const tenantId = (p.get("tenantId") ?? "").trim();
  const search = (p.get("search") ?? "").trim();
  const limit = p.get("limit") === null ? 40 : parseStrictListOffset(p.get("limit"), 100);
  const offset = parseStrictListOffset(p.get("offset"), 10_000);
  if (limit === null || limit < 1 || offset === null) {
    return NextResponse.json({ error: "Invalid integration pagination", code: "INVALID_PAGINATION" }, { status: 400, headers: HEADERS });
  }
  if (!(["keys", "installations"].includes(kind)) ||
      !(["all", "active", "inactive"].includes(status)) ||
      tenantId.length > 120 || (search.length > 0 && (search.length < 2 || search.length > 64))) {
    return NextResponse.json({ error: "Invalid integration filter" }, { status: 400, headers: HEADERS });
  }
  const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
  try {
    if (kind === "keys") {
      const conditions: SQL[] = [];
      if (tenantId) conditions.push(eq(apiKeys.tenantId, tenantId));
      const rotationGrace = and(isNotNull(apiKeys.revokedAt), isNotNull(apiKeys.readOnlyUntil),
        gt(apiKeys.readOnlyUntil, sql`clock_timestamp()`));
      if (status === "active") conditions.push(or(isNull(apiKeys.revokedAt), rotationGrace)!);
      if (status === "inactive") conditions.push(and(isNotNull(apiKeys.revokedAt),
        or(isNull(apiKeys.readOnlyUntil), lte(apiKeys.readOnlyUntil, sql`clock_timestamp()`)))!);
      if (search) conditions.push(or(ilike(apiKeys.name, term), ilike(apiKeys.id, term), ilike(tenants.name, term))!);
      const rows = await queryWithTimeout(() => db.transaction(async tx => {
        await requirePlatformReadAuthorityInTransaction(tx, actor);
        return tx.select({
        id: apiKeys.id, tenantId: apiKeys.tenantId, tenantName: tenants.name,
        name: apiKeys.name, description: apiKeys.description,
        createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt,
        odooEnabled: apiKeys.odooEnabled,
        revokedAt: apiKeys.revokedAt, readOnlyUntil: apiKeys.readOnlyUntil,
        graceActive: sql<boolean>`${apiKeys.revokedAt} IS NOT NULL AND ${apiKeys.readOnlyUntil} IS NOT NULL AND ${apiKeys.readOnlyUntil} > clock_timestamp()`,
        // Aggregated metadata only: one API key can enroll several Odoo databases.
        // Never multiply API-key rows via a one-to-many credential JOIN.
        installationId: sql<string | null>`(SELECT c.installation_id
          FROM odoo_installation_credentials c
          WHERE c.tenant_id = ${apiKeys.tenantId} AND c.api_key_id = ${apiKeys.id}
          ORDER BY c.created_at, c.installation_id LIMIT 1)`,
        installationName: sql<string | null>`(SELECT i.name
          FROM odoo_installation_credentials c
          JOIN odoo_installations i ON i.tenant_id = c.tenant_id AND i.id = c.installation_id
          WHERE c.tenant_id = ${apiKeys.tenantId} AND c.api_key_id = ${apiKeys.id}
          ORDER BY c.created_at, c.installation_id LIMIT 1)`,
        installationCount: sql<number>`(SELECT COUNT(*)::int
          FROM odoo_installation_credentials c
          WHERE c.tenant_id = ${apiKeys.tenantId} AND c.api_key_id = ${apiKeys.id})`,
      }).from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .where(and(...conditions))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
        .limit(limit + 1).offset(offset);
      }), 6_000, "platformIntegrationKeys");
      return NextResponse.json({ kind, items: rows.slice(0, limit), hasMore: rows.length > limit, limit, offset }, { headers: HEADERS });
    }
    const conditions: SQL[] = [];
    if (tenantId) conditions.push(eq(odooInstallations.tenantId, tenantId));
    if (status !== "all") conditions.push(eq(odooInstallations.enabled, status === "active"));
    if (search) conditions.push(or(ilike(odooInstallations.name, term), ilike(odooInstallations.id, term), ilike(tenants.name, term))!);
    const rows = await queryWithTimeout(() => db.transaction(async tx => {
        await requirePlatformReadAuthorityInTransaction(tx, actor);
        return tx.select({
      id: odooInstallations.id, tenantId: odooInstallations.tenantId,
      tenantName: tenants.name, name: odooInstallations.name,
      enabled: odooInstallations.enabled, disabledAt: odooInstallations.disabledAt,
      createdAt: odooInstallations.createdAt,
      credentialCount: sql<number>`(SELECT count(*)::int FROM ${odooInstallationCredentials} WHERE ${odooInstallationCredentials.installationId} = ${odooInstallations.id} AND ${odooInstallationCredentials.tenantId} = ${odooInstallations.tenantId})`,
    }).from(odooInstallations).innerJoin(tenants, eq(tenants.id, odooInstallations.tenantId))
      .where(and(...conditions)).orderBy(desc(odooInstallations.createdAt), desc(odooInstallations.id))
      .limit(limit + 1).offset(offset);
    }), 6_000, "platformOdooInstallations");
    return NextResponse.json({ kind, items: rows.slice(0, limit), hasMore: rows.length > limit, limit, offset }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Integration inventory unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
}
