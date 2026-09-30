import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ui = readFileSync("src/components/ui.tsx", "utf8");
const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
const certification = readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");

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
    expect(dashboard).toContain('description="Run a controlled real-print certification');
    expect(dashboard).toContain("wide");
    expect(dashboard).not.toContain("<Drawer\n        open={certifyPrinter");
  });

  it("keeps certification content readable and structured", () => {
    expect(certification).toContain("Certification stages");
    expect(certification).toContain("Overall result");
    expect(certification).toContain("Physical print verification");
    expect(certification).toContain("text-[14px] leading-relaxed");
    expect(certification).not.toContain("text-[10px]");
    expect(certification).not.toContain("text-[11px] text-ink-4");
  });
});
