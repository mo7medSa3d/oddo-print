import { RefreshCw } from "lucide-react";
import { Button, Card, StatusBadge } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import type { DesktopState } from "../types";
import { isMainInventoryPrinter, printerPresentation } from "../lib/printers";

/** Progress comes from authenticated replies and current verified inventory.
 * Public Gateway health and a running local service never prove pairing. */
export function SetupGuide({ s }: { s: DesktopState }) {
  const { t } = useI18n();
  const ready = s.printers.filter(isMainInventoryPrinter).some((p) => printerPresentation(p, undefined, s.nowMs).state === "ready");
  const steps = [
    { title: "v4.experience.setup.gateway", body: "v4.experience.setup.gatewayBody", complete: s.gatewayConnected, action: () => s.navigate("settings") },
    { title: "v4.experience.setup.pair", body: "v4.experience.setup.pairBody", complete: s.pairingConfirmed, action: () => s.navigate("settings") },
    { title: "v4.experience.setup.discover", body: "v4.experience.setup.discoverBody", complete: s.printers.some(isMainInventoryPrinter), action: () => s.navigate("printers") },
    { title: "v4.experience.setup.verify", body: "v4.experience.setup.verifyBody", complete: ready, action: () => s.navigate("printers") },
  ] as const;
  const active = steps.findIndex((step) => !step.complete);
  if (active === -1) return null;
  return <Card className="p-4 sm:p-5">
    <h2 className="text-base font-medium text-ink">{t("v4.experience.setup.title")}</h2>
    <ol className="mt-3">
      {steps.filter((_, index) => index === active).map((step) => <li key={step.title} className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface-2 p-3">
        <div className="min-w-0 flex-1"><h3 className="font-medium text-ink">{t(step.title)}</h3><p className="mt-1 text-sm text-ink-3">{t(step.body)}</p><StatusBadge tone="neutral" label={t("v4.experience.setup.pending")} /></div>
        {<Button variant="primary" onClick={active === 2 ? s.handleDiscover : step.action} loading={(s.busy || s.printersLoading) && active === 2} disabled={(s.busy || s.printersLoading) && active === 2} icon={active === 2 ? <RefreshCw className="h-4 w-4" /> : undefined}>{t(active === 2 ? "desktop.printers.discover" : "v4.experience.setup.open")}</Button>}
      </li>)}
    </ol>

  </Card>;
}
