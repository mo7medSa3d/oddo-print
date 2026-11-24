"use client";

import { useI18n } from "../i18n/react";
import { Callout, KeyValueList } from "./ui";
import { isPrinterOperationallyVerified, validatePrinterOperationalVerification, type OperationalPrinterState } from "../lib/printer-operational-verification";

export function PrinterVerificationDetails({ printer }: { printer: OperationalPrinterState & { localObservedAt?: number } }) {
  const { t, formatDateTime } = useI18n();
  const caps = printer.capabilities && typeof printer.capabilities === "object" ? printer.capabilities as Record<string, unknown> : {};
  const native = typeof printer.localObservedAt === "number" ? validatePrinterOperationalVerification(caps.operational_verification, printer) : null;
  const verified = native ? native.ok : isPrinterOperationallyVerified(printer);
  const verifiedAt = native?.ok ? native.value.verified_at : printer.verificationVerifiedAt;
  return <section className="space-y-3" aria-label={t("printer.verification.title")}>
    <h3 className="text-sm font-semibold text-ink">{t("printer.verification.title")}</h3>
    <KeyValueList rows={[
      { label: t("common.status"), value: t(verified ? "printer.verification.verified" : "printer.verification.pending") },
      { label: t("printer.verification.outputMedium"), value: t("printer.verification.physical") },
      { label: t("printer.verification.lastVerified"), value: verifiedAt ? <span className="tabular-nums">{formatDateTime(verifiedAt)}</span> : "—" },
    ]} />
    {!verified && <Callout tone="warn">{t("printer.verification.pendingHelp")}</Callout>}
  </section>;
}
