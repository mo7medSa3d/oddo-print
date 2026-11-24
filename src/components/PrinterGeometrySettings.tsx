"use client";

import { useState } from "react";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/messages/en";
import { Button, Callout, Checkbox, Field, Input, KeyValueList } from "./ui";
import {
  currentPrinterGeometry,
  validatePrinterGeometryProfile,
  type GeometryPrinterState,
  type PrinterGeometryProfile,
} from "../lib/printer-geometry";

/** Only explicitly localized errors may be displayed to the operator. */
export class LocalizedGeometrySaveError extends Error {}

type GeometryPrinter = GeometryPrinterState & {
  config?: Record<string, unknown> | null;
  connectionType?: string | null;
  protocol?: string | null;
};

/** Existing printer details use the same verified measurements as admission. */
export function PrinterGeometryDetails({ printer, managerHint = false }: { printer: GeometryPrinter; managerHint?: boolean }) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const geometry = currentPrinterGeometry(printer);
  return <section className="space-y-3" aria-label={t("printer.geometry.title")}>
    <h3 className="text-sm font-semibold text-ink">{t("printer.geometry.title")}</h3>
    {geometry ? <KeyValueList rows={[
      { label: t("printer.geometry.widthDots"), value: <bdi dir="ltr" className="tabular-nums">{formatNumber(geometry.printable_width_dots)}</bdi> },
      { label: t("printer.geometry.dpiX"), value: geometry.dpi_x === undefined ? "—" : <bdi dir="ltr" className="tabular-nums">{formatNumber(geometry.dpi_x)}</bdi> },
      { label: t("printer.geometry.dpiY"), value: geometry.dpi_y === undefined ? "—" : <bdi dir="ltr" className="tabular-nums">{formatNumber(geometry.dpi_y)}</bdi> },
      { label: t("printer.geometry.paperWidth"), value: geometry.paper_width_mm === undefined ? "—" : <bdi dir="ltr" className="tabular-nums">{formatNumber(geometry.paper_width_mm, { maximumFractionDigits: 3 })}</bdi> },
      { label: t("printer.geometry.source"), value: t(geometry.source === "validated_profile" ? "printer.geometry.sourceProfile" : geometry.source === "ipp" ? "printer.geometry.sourceIpp" : "printer.geometry.sourceDriver") },
      { label: t("printer.geometry.observed"), value: <span className="tabular-nums">{formatDateTime(geometry.observed_at)}</span> },
    ]} /> : <Callout tone="warn">{t("printer.geometry.unknown")}</Callout>}
    {managerHint && <p className="text-sm text-ink-3">{t("printer.geometry.managerHint")}</p>}
  </section>;
}

const fields = [
  ["printable_width_dots", "printer.geometry.widthDots", 1, 16384, 1],
  ["dpi_x", "printer.geometry.dpiX", 1, 9600, 1],
  ["dpi_y", "printer.geometry.dpiY", 1, 9600, 1],
  ["paper_width_mm", "printer.geometry.paperWidth", 0.001, 10000, "any"],
  ["paper_height_mm", "printer.geometry.paperHeight", 0.001, 10000, "any"],
  ["printable_height_dots", "printer.geometry.heightDots", 1, 1000000, 1],
  ["offset_x_dots", "printer.geometry.offsetX", 0, 1000000, 1],
  ["offset_y_dots", "printer.geometry.offsetY", 0, 1000000, 1],
] as const;
type NumericProfileField = (typeof fields)[number][0];

export function PrinterGeometryProfileEditor({ printer, onSave }: {
  printer: GeometryPrinter;
  onSave: (profile: PrinterGeometryProfile | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const existing = validatePrinterGeometryProfile(printer.config?.geometry_profile);
  const [values, setValues] = useState<Record<NumericProfileField, string>>(() => Object.fromEntries(
    fields.map(([field]) => [field, existing.ok && existing.value[field] !== undefined ? String(existing.value[field]) : ""]),
  ) as Record<NumericProfileField, string>);
  const [raster, setRaster] = useState(existing.ok && existing.value.raster_command === "gs_v_0");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const rasterApplicable = ((printer.connectionType === "network" || printer.connectionType === "usb") && printer.protocol === "escpos") || raster;

  async function save(profile: PrinterGeometryProfile | null) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(profile);
      if (profile === null) {
        setValues(Object.fromEntries(fields.map(([field]) => [field, ""])) as Record<NumericProfileField, string>);
        setRaster(false);
      }
      setSaved(true);
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof LocalizedGeometrySaveError ? cause.message : t("printer.geometry.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <details className="rounded-md border border-edge px-4 py-3">
    <summary className="cursor-pointer rounded-sm text-sm font-semibold text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("printer.geometry.profileTitle")}</summary>
    <form className="mt-4 space-y-4" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !confirmed) return;
      const profile: Record<string, unknown> = {};
      for (const [field] of fields) if (values[field].trim() !== "") profile[field] = Number(values[field]);
      if (raster) profile.raster_command = "gs_v_0";
      const parsed = validatePrinterGeometryProfile(profile);
      if (!parsed.ok) { setError(t("printer.geometry.invalid")); return; }
      void save(parsed.value);
    }}>
      <p className="text-sm leading-relaxed text-ink-3">{t("printer.geometry.profileHelp")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map(([field, label, min, max, step]) => <Field key={field} label={t(label as MessageKey)} required={field === "printable_width_dots"} optional={field !== "printable_width_dots"}>
          <Input name={field} type="number" dir="ltr" inputMode="decimal" className="tabular-nums" min={min} max={max} step={step}
            value={values[field]} disabled={busy} required={field === "printable_width_dots"}
            onChange={(event) => { setValues((current) => ({ ...current, [field]: event.target.value })); setConfirmed(false); setSaved(false); }} />
        </Field>)}
      </div>
      {rasterApplicable && <Checkbox checked={raster} disabled={busy} label={t("printer.geometry.rasterCommand")}
        description={t("printer.geometry.rasterHelp")}
        onChange={(event) => { setRaster(event.target.checked); setConfirmed(false); setSaved(false); }} />}
      <Checkbox checked={confirmed} disabled={busy} label={t("printer.geometry.confirm")}
        onChange={(event) => setConfirmed(event.target.checked)} />
      {error && <Callout tone="bad">{error}</Callout>}
      {saved && <Callout tone="ok">{t("printer.geometry.saved")}</Callout>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy || !confirmed}>{busy ? t("common.saving") : t("printer.geometry.save")}</Button>
        {existing.ok && <Button type="button" variant="secondary" disabled={busy} onClick={() => void save(null)}>{t("printer.geometry.remove")}</Button>}
      </div>
    </form>
  </details>;
}
