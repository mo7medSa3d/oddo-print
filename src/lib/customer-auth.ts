import { db } from "../db";
import { tenantUsers } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { authenticateCustomer, createManagerSession, managerCookieHeader, type ManagerRole } from "./manager-auth";
import { normalizeEmail } from "./password";

export async function issueCustomerSession(userId: string, tenantId: string, role: ManagerRole) {
  const session = await createManagerSession(tenantId, { userId, role });
  return session;
}

export function customerSessionCookie(session: { token: string; exp: Date }) {
  return managerCookieHeader(session.token, session.exp);
}

export async function authenticateForTenant(email: string, password: string, tenantId?: string) {
  const identity = await authenticateCustomer(email, password);
  if (!identity) return null;
  if (tenantId) {
    const membership = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.userId, identity.userId), eq(tenantUsers.tenantId, tenantId)), columns: { tenantId: true, role: true } });
    if (!membership) return null;
    return { ...identity, tenantId: membership.tenantId, role: membership.role as ManagerRole };
  }
  const memberships = await db.select({ tenantId: tenantUsers.tenantId, role: tenantUsers.role }).from(tenantUsers).where(eq(tenantUsers.userId, identity.userId)).limit(2);
  if (memberships.length !== 1) return { ...identity, multipleTenants: memberships.length > 1, memberships };
  return { ...identity, tenantId: memberships[0].tenantId, role: memberships[0].role as ManagerRole };
}

export { normalizeEmail };
