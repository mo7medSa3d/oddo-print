import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("overlay and job evidence contracts", () => {
  it("keeps menus above navigation and dialogs", () => {
    const ui = read("src/components/ui.tsx");
    const shell = read("src/components/AppShell.tsx");
    expect(ui).toContain("menu-surface z-[120]");
    expect(ui).toContain('className="fixed inset-0 z-[100] flex items-stretch');
    expect(ui).toContain('data-dialog-root className="fixed inset-0 z-[100] flex justify-end"');
    expect(shell).toContain('data-dialog-root className="fixed inset-0 z-[80] lg:hidden"');
  });

  it("keeps modal content visible and scrollable on phone viewports", () => {
    const ui = read("src/components/ui.tsx");
    expect(ui).toContain("h-[100dvh] max-h-[100dvh]");
    expect(ui).toContain("sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:rounded-md");
    expect(ui).toContain("min-h-0 flex-1 overflow-y-auto overflow-x-hidden");
  });

  it("switches the jobs table to the compact list until XL width", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain('className="hidden overflow-x-auto xl:block"');
    expect(dashboard).toContain('className="divide-y divide-edge-subtle xl:hidden"');
  });

  it("renders job action menus through the shared portal and opens them above the trigger", () => {
    const ui = read("src/components/ui.tsx");
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(ui).toContain("createPortal(");
    expect(ui).toContain('position: "fixed"');
    const jobMenuPlacements = dashboard.match(/items=\{jobActions\(job\)\}[\s\S]{0,180}?placement="above"/g) ?? [];
    expect(jobMenuPlacements).toHaveLength(2);
  });

  it("keeps fleet cards aligned to content instead of stretching to the tallest sibling", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain('className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-12"');
  });


  it("keeps printer cards on phone layouts even when table is selected", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain('printerViewMode === "table" ? "xl:hidden" : ""');
    expect(dashboard).toContain('className="hidden min-w-0 overflow-x-auto xl:block"');
    expect(dashboard).toContain('className="hidden xl:block"');
  });

  it("keeps platform plan and subscription controls readable on phones", () => {
    const ui = read("src/components/ui.tsx");
    const plans = read("src/app/platform/plans/page.tsx");
    const subscriptions = read("src/app/platform/subscriptions/page.tsx");

    expect(ui).toContain('className={option.icon ? "hidden sm:inline" : "inline"}');
    expect(ui).toContain("inline-flex max-w-full items-center");
    expect(plans).toContain('className="divide-y divide-edge-subtle lg:hidden"');
    expect(plans).toContain('className="hidden lg:block"');
    expect(subscriptions).toContain('className="divide-y divide-edge-subtle sm:hidden"');
    expect(subscriptions).toContain('className="hidden overflow-x-auto sm:block"');
  });

  it("loads an authoritative job snapshot before rendering job evidence", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain("setSelectedJobDetails(row)");
    expect(dashboard).toContain("selectedJobDetails?.id === selectedJob.id");
    expect(dashboard).toContain("selectedJobView");
  });

  it("never invents timeline events from current job state", () => {
    const route = read("src/app/api/jobs/[id]/timeline/route.ts");
    expect(route).toContain("getJobTimeline");
    expect(route).toContain('source: timeline.length > 0 ? "persisted_events" : "job_record_only"');
    expect(route).not.toContain("buildTimelineFromJobRow");
    expect(route).not.toContain("derived_");
  });
});
