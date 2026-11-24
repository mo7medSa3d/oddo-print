import { and, eq } from "drizzle-orm";
import type { DbTx } from "../db";
import { apiKeys, odooInstallationCredentials } from "../db/schema";

/** Delete a credential row and its installation bindings.
 * Caller must take the api_keys:tenant lock and recheck live authority. */
export async function deleteApiKeyInTransaction(tx: DbTx, tenantId: string, id: string): Promise<boolean> {
  const found = await tx.select({ id: apiKeys.id }).from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id))).for("update");
  if (!found.length) return false;
  await tx.delete(odooInstallationCredentials).where(and(
    eq(odooInstallationCredentials.tenantId, tenantId),
    eq(odooInstallationCredentials.apiKeyId, id),
  ));
  await tx.delete(apiKeys).where(and(
    eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id),
  ));
  return true;
}
