// @vitest-environment jsdom
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { PrinterVerificationDetails } from "../src/components/PrinterVerificationDetails";
import { verifiedPrinterState } from "./helpers/printer-verification";
const render = (child: React.ReactNode, locale: "en" | "ar" = "en") => renderToStaticMarkup(h(I18nProvider, { initialLocale: locale, children: child }));
describe("existing printer details show verification honestly", () => {
  it("shows unproven online registrations as pending rather than verified", () => {
    const html = render(h(PrinterVerificationDetails, { printer: { id: "pending", connectionType: "spooler", protocol: "spooler" } }));
    expect(html).toContain("Pending verification"); expect(html).toContain("must verify this exact queue"); expect(html).not.toContain("Verified Agent access");
  });
  it("labels a recent verified physical printer as physical output", () => {
    const html = render(h(PrinterVerificationDetails, { printer: { ...verifiedPrinterState(), connectionType: "spooler", protocol: "spooler" } }));
    expect(html).toContain("Verified Agent access"); expect(html).toContain("Physical printer");
  });
});
