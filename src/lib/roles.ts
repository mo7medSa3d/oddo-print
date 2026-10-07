import type { Translator } from "../i18n/translate";

/** Localized workspace role name. Unknown future roles fall back to readable English. */
export function roleLabel(role: string, t: Translator): string {
  switch (role) {
    case "owner":
      return t("team.role.owner");
    case "admin":
      return t("team.role.admin");
    case "operator":
      return t("team.role.operator");
    case "viewer":
      return t("team.role.viewer");
    case "integration_admin":
      return t("team.role.integrationAdmin");
    case "billing_admin":
      return t("team.role.billingAdmin");
    default:
      return role.replace(/_/g, " ");
  }
}
