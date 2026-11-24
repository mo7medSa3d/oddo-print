"use client";

import Link from "next/link";
import { Card, CardHeader, PageHeader } from "../../../components/ui";
import { SessionInventory } from "../../../components/SessionInventory";
import { useI18n } from "../../../i18n/react";

// No step-up: platform session management needs only a valid platform
// session. Revoking sessions (including this device) is a one-click action
// in the inventory below; expired sessions go to platform sign-in.
export default function PlatformSecurityPage() {
  const { t } = useI18n();
  return <div className="space-y-6">
    <nav aria-label={t("platform.section.security")} className="flex flex-wrap gap-4"><Link href="/platform/audit" className="rounded-sm text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("platform.nav.audit")}</Link><Link href="/platform/database" className="rounded-sm text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("platform.nav.database")}</Link></nav>
    <PageHeader variant="inline" title={t("security.title")} />
    <Card><CardHeader title={t("security.title")} subtitle={t("security.platformSessionsHint")} /></Card>
    <SessionInventory platform />
  </div>;
}
