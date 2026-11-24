import type { ManagerClaims, ManagerRole } from "./manager-auth";
import { recordAuthorizationDenial } from "../server/authorization-monitor";

export type ManagerPermission =
  | "tenant.read" | "tenant.update"
  | "users.read" | "users.manage"
  | "agents.read" | "agents.pair" | "agents.disable" | "agents.retire"
  | "printers.read" | "printers.manage" | "printers.test"
  | "jobs.read" | "jobs.payload.read" | "jobs.create" | "jobs.retry" | "jobs.cancel"
  | "bindings.read" | "bindings.manage"
  | "integrations.read" | "integrations.manage"
  | "billing.read" | "billing.manage";

const FULL_ACCESS_PERMISSIONS: ReadonlySet<ManagerPermission> = new Set<ManagerPermission>([
  "tenant.read", "tenant.update",
  "users.read",
  "agents.read",
  "agents.pair",
  "agents.disable",
  "agents.retire",
  "printers.read",
  "printers.manage",
  "printers.test",
  "jobs.read",
  "jobs.payload.read",
  "jobs.create",
  "jobs.retry",
  "jobs.cancel",
  "bindings.read",
  "bindings.manage",
  "integrations.read",
  "integrations.manage",
]);

/** Only the workspace owner reads/requests billing; commercial mutations require Platform Owner authority. */
const permissionsByRole: Record<ManagerRole, ReadonlySet<ManagerPermission>> = {
  owner: new Set<ManagerPermission>([...FULL_ACCESS_PERMISSIONS, "billing.read"]),
  admin: FULL_ACCESS_PERMISSIONS,
  operator: FULL_ACCESS_PERMISSIONS,
  viewer: FULL_ACCESS_PERMISSIONS,
  integration_admin: FULL_ACCESS_PERMISSIONS,
  billing_admin: FULL_ACCESS_PERMISSIONS,
};
export function hasManagerPermission(claims: ManagerClaims, permission: ManagerPermission): boolean {
  return permissionsByRole[claims.role]?.has(permission) ?? false;
}

export function requireManagerPermission(claims: ManagerClaims, permission: ManagerPermission): void {
  if (!hasManagerPermission(claims, permission)) {
    recordAuthorizationDenial("manager", 403, {
      permission, role: claims.role, actorId: claims.userId, tenantId: claims.tenantId,
    });
    const error = new Error(`Missing permission: ${permission}`);
    Object.assign(error, { code: "FORBIDDEN", status: 403 });
    throw error;
  }
}

export function managerPermissions(claims: ManagerClaims): ManagerPermission[] {
  return [...(permissionsByRole[claims.role] ?? [])];
}
