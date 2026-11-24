// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { PrinterGeometryDetails, PrinterGeometryProfileEditor } from "../src/components/PrinterGeometrySettings";
import fixtures from "../contracts/printer-geometry-fixtures.json";

afterEach(() => vi.unstubAllGlobals());
const tree = (children: React.ReactNode, locale: "en" | "ar" = "en") => h(I18nProvider, { initialLocale: locale, children });
const printer = { id: "receipt-printer", connectionType: "usb", protocol: "escpos" };

describe("verified profiles in existing printer details", () => {
  it("shows unknown geometry and the existing manager configuration path without guessed dimensions", () => {
    const html = renderToStaticMarkup(tree(h(PrinterGeometryDetails, { printer: { ...printer, capabilities: { paper_width_mm: 80, max_paper_width: 576 } }, managerHint: true })));
    expect(html).toContain("measurements are unavailable");
    expect(html).toContain("Gateway details");
    expect(html).not.toContain("576");
  });

  it("displays high-DPI measurements in English and Arabic without changing their units", () => {
    const geometry = fixtures.geometryCases.find((entry) => entry.name === "physical-1664-dots-600-dpi-80-mm")!.geometry;
    for (const locale of ["en", "ar"] as const) {
      const profile = Object.fromEntries(Object.entries(geometry).filter(([key]) =>
        !["version", "source", "validation", "observed_at", "printer_id", "config_fingerprint"].includes(key)));
      const html = renderToStaticMarkup(tree(h(PrinterGeometryDetails, {
        printer: { ...printer, capabilities: { geometry }, config: { geometry_profile: profile } },
      }), locale));
      expect(html).not.toContain("undefined");
      expect(html).not.toContain("printer.geometry.");
      expect(html).not.toContain("measurements are unavailable");
    }
  });

  it("submits the exact verified profile after explicit operator confirmation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const profile = { printable_width_dots: 1700, dpi_x: 600, dpi_y: 300, paper_width_mm: 82, raster_command: "gs_v_0" as const };
    const onSave = vi.fn(async () => {});
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    try {
      await act(async () => root.render(tree(h(PrinterGeometryProfileEditor, { printer: { ...printer, config: { geometry_profile: profile } }, onSave }))));
      const save = host.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      expect((host.querySelector('input[name="printable_width_dots"]') as HTMLInputElement).value).toBe("1700");
      expect((host.querySelector('input[name="offset_x_dots"]') as HTMLInputElement).value).toBe("");
      const confirm = [...host.querySelectorAll('input[type="checkbox"]')].at(-1) as HTMLInputElement;
      await act(async () => confirm.click());
      expect(save.disabled).toBe(false);
      await act(async () => save.click());
      expect(onSave).toHaveBeenCalledExactlyOnceWith(profile);
      expect(host.textContent).toContain("Profile saved");
      expect(save.disabled).toBe(true);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("keeps optional measurements empty when no profile exists", () => {
    const html = renderToStaticMarkup(tree(h(PrinterGeometryProfileEditor, { printer, onSave: async () => {} })));
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const input of doc.querySelectorAll('input[type="number"]')) expect((input as HTMLInputElement).value).toBe("");
    expect((doc.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
