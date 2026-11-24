import { ClipboardList } from "lucide-react";
import { Card, CardHeader } from "../../components/ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";

/** Odoo is the only print-queue and job-history authority in Direct mode. */
export function JobsPage(_props: { s: DesktopState }) {
  const { t } = useI18n();
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardHeader title={t("desktop.jobs.odooTitle")} icon={<ClipboardList className="h-4 w-4 text-brand" />} />
      <div className="px-6 pb-6 text-sm leading-relaxed text-ink-2">{t("desktop.jobs.odooBody")}</div>
    </Card>
  );
}
