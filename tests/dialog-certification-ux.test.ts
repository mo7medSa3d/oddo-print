import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ui = readFileSync("src/components/ui.tsx", "utf8");
const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
const certification = readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");
const uiButtons = ui.slice(ui.indexOf("const buttonVariants"), ui.indexOf("type ButtonProps"));

describe("dialog and printer certification UX contracts", () => {
  it("locks and restores page scroll while a dialog is open", () => {
    expect(ui).toContain("bodyLockScrollY = window.scrollY");
    expect(ui).toContain('body.style.position = "fixed"');
    expect(ui).toContain('body.style.overflow = "hidden"');
    expect(ui).toContain("window.scrollTo(0, bodyLockScrollY)");
    expect(ui).toContain("if (openDialogCount === 0) lockBodyScroll()");
    expect(ui).toContain("if (openDialogCount === 0) unlockBodyScroll()");
  });

  it("opens printer certification in the same centered modal primitive as other inspectors", () => {
    expect(dashboard).toContain("title={certifyPrinter ?");
    expect(dashboard).toContain('description={t("printer.certifyDescription")}');
    expect(dashboard).toContain("wide");
    expect(dashboard).not.toContain("<Drawer\n        open={certifyPrinter");
  });

  it("uses theme-aware contrast colors for every solid button variant", () => {
    expect(uiButtons).toContain("bg-brand text-brand-contrast");
    expect(uiButtons).toContain("bg-bad-solid text-on-solid");
    expect(uiButtons).toContain("bg-ok-solid text-on-solid");
  });

  it("keeps certification content readable and structured", () => {
    expect(certification).toContain('t("cert.stagesHeading")');
    expect(certification).toContain('t("cert.overallResult")');
    expect(certification).toContain('t("cert.physicalTitle")');
    expect(certification).toContain("text-[14px] leading-relaxed");
    expect(certification).not.toContain("text-[10px]");
    expect(certification).not.toContain("text-[11px] text-ink-4");
  });
});
