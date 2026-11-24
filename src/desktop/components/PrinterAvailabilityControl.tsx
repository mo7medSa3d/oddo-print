import { useId } from "react";
import { Link2, Link2Off } from "lucide-react";
import { Button, StatusBadge } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import type { DesktopState } from "../types";
import type { PrinterInfo } from "../lib/ipc";
import { isLocalSetupCandidate, printerDisplayName, printerIsStale } from "../lib/printers";

/** Only a confirmed local ID can change the Agent's protected sharing policy. */
export function PrinterAvailabilityControl({ s, printer, candidate = false }: { s: DesktopState; printer: PrinterInfo; candidate?: boolean }) {
  const { t, locale } = useI18n();
  const descriptionId = useId();
  const local = s.localPrinters.find((p) => p.id === printer.id);
  // Sharing is a local Agent policy. Odoo receives it on the next heartbeat;
  // Desktop does not keep a second, Cloud-side printer inventory.
  if (!local && !candidate) {
    // A non-local row (another machine's agent, or a
    // stale historical row) must explain itself, not vanish: a missing control
    // reads as a broken toggle.
    return <div className="min-w-0 max-w-full space-y-2 text-start" data-printer-sharing={printer.id}>
      <div className="max-w-full space-y-1 text-xs text-ink-3 [overflow-wrap:anywhere]">
        <p>{t("desktop.printers.sharingNoLocal")}</p>
      </div>
    </div>;
  }
  const shared = (local ?? printer).availableToOdoo !== false;
  const pending = s.availabilityPendingPrinterIds.has(printer.id);
  // A pending Agent heartbeat is not an unverified local device. A fresh,
  // native-confirmed local identity may opt into sharing before its first
  // cloud inventory appearance; discovered-only/setup candidates cannot.
  const unproven = !local || isLocalSetupCandidate(local);
  const actionShared = shared && !unproven;
  // WHY, not just "disabled": a detected-only row has no verified binding
  // yet, which is a different next step than a candidate-only row's setup.
  const verification = local?.capabilities?.verification;
  const disabledReason = unproven
    ? t(verification === "device_detected_only" ? "desktop.printers.sharingDetectedOnly" : "desktop.printers.sharingSetupRequired")
    : !s.canManagePrinterVisibility ? t("desktop.printers.sharingAdminRequired")
      : !s.localInventoryReady || (local && printerIsStale(local, s.nowMs)) ? t("desktop.printers.sharingRefreshRequired") : null;
  const error = s.availabilityErrors[printer.id];
  const showExplanation = disabledReason || !shared || error;
  return <div className="min-w-0 max-w-full space-y-2 text-start" data-printer-sharing={printer.id}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <StatusBadge tone={shared && !unproven ? "info" : "neutral"} label={t(unproven ? "printer.presentation.unavailable" : shared ? "desktop.printers.sharingShared" : "desktop.printers.sharingPrivate")} />
      <Button size="sm" variant="secondary" disabled={!!disabledReason || pending} loading={pending}
        icon={actionShared ? <Link2Off className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
        aria-label={t(actionShared ? "desktop.printers.sharingStopAria" : "desktop.printers.sharingShareAria", { name: printerDisplayName(printer, locale) })}
        aria-describedby={showExplanation ? descriptionId : undefined}
        onClick={() => void s.handlePrinterVisibility(printer.id, !shared)}>
        {t(actionShared ? "desktop.printers.sharingStop" : "desktop.printers.sharingShare")}
      </Button>
    </div>
    {showExplanation && <div id={descriptionId} className="max-w-full space-y-1 text-xs text-ink-3 [overflow-wrap:anywhere]">
      {disabledReason && <p>{disabledReason}</p>}
      {!shared && <p>{t("desktop.printers.sharingPrivateHint")}</p>}
      {error && <p role="alert" className="text-bad">{error}</p>}
    </div>}
  </div>;
}

export { PrinterAvailabilityControl as PrinterVisibilityControl, PrinterAvailabilityControl as PrinterSharingControl };

