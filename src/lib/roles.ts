import type { Translator } from "../i18n/translate";

/** All authenticated workspace members use the same operational access level. */
export function roleLabel(role: string, t: Translator): string {
  if (role === "owner") return t("team.role.owner");
  return ["admin", "operator", "viewer", "integration_admin", "billing_admin"].includes(role)
    ? t("v4.team.fullAccess")
    : t("common.unknown");
}
