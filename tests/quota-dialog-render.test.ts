// @vitest-environment jsdom
/**
 * The quota-exhausted dialog must render the exact fields the limit signal
 * carries: which allowance was hit, what was used against what limit, when the
 * current billing period ends, and the upgrade path. This renders the real
 * component (no testing library) instead of asserting on source text.
 *
 * Dialogs are portaled to document.body (viewport-level root), so assertions
 * read from document.body rather than the React host container.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import UpgradeLimitDialog, { type UpgradeLimitResource } from "../src/components/UpgradeLimitDialog";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
  for (const host of hosts) host.remove();
  hosts = [];
  document.body.innerHTML = "";
});

function renderDialog(props: {
  open: boolean;
  resource?: UpgradeLimitResource;
  used?: number | null;
  limit?: number | "unlimited" | null;
  periodEnd?: string | null;
  retryAfterSeconds?: number | null;
  onClose?: () => void;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  hosts.push(host);
  roots.push(root);
  act(() => {
    root.render(h(UpgradeLimitDialog, {
      open: props.open,
      onClose: props.onClose ?? (() => {}),
      resource: props.resource ?? "prints",
      used: props.used,
      limit: props.limit,
      periodEnd: props.periodEnd,
      retryAfterSeconds: props.retryAfterSeconds,
    }) as never);
  });
  return document.body;
}

describe("quota-exhausted upgrade dialog", () => {
  it("renders the billing-period print limit with usage and the upgrade path", () => {
    const body = renderDialog({
      open: true,
      resource: "prints",
      used: 500,
      limit: 500,
      periodEnd: "2026-10-01T00:00:00.000Z",
    });

    const text = body.textContent ?? "";
    expect(text).toContain("Print limit reached");
    expect(text).toContain("You've used all prints for this period");
    expect(text).toContain("1 print = 1 credit.");
    // Usage must reflect the signal, not a guess.
    expect(text).toContain("500");
    expect(text).toContain("Used");
    expect(text).toContain("Plan limit");
    // The period end is rendered as a date, never as a raw timestamp.
    expect(text).toMatch(/\d{4}/);
    expect(text).not.toContain("2026-10-01T00:00:00.000Z");

    const upgrade = body.querySelector('a[href="/billing"]');
    expect(upgrade).not.toBeNull();
    expect(upgrade?.textContent ?? "").toContain("Upgrade plan");

    // Portal architecture: dialog mounts at body level, above dashboard containers.
    const root = body.querySelector("[data-dialog-root]");
    expect(root).not.toBeNull();
    expect(root?.parentElement).toBe(document.body);
  });

  it("explains a rolling rate limit and a concurrency limit differently", () => {
    const body = renderDialog({ open: true, resource: "rate", used: 20, limit: 20, retryAfterSeconds: 60 });
    // Each render appends a new portal; scope to the last dialog root.
    const roots = body.querySelectorAll('[role="dialog"]');
    const rateText = roots[roots.length - 1]?.textContent ?? "";
    // A rate limit is a throughput window measured in jobs per minute, and it
    // resets on its own: the remedy is to wait, not to upgrade.
    expect(rateText).toContain("Print rate limit reached");
    expect(rateText).toContain("jobs per minute");
    expect(rateText).toContain("This resets soon");

    // A concurrency limit counts jobs in flight right now. It is reported in
    // active jobs and explained as a present-tense count, so the operator is
    // not told to wait out a window that does not exist.
    const before = body.querySelectorAll('[role="dialog"]').length;
    renderDialog({ open: true, resource: "concurrency", used: 5, limit: 5 });
    const all = body.querySelectorAll('[role="dialog"]');
    const concurrencyText = all[all.length - 1]?.textContent ?? all[before - 1]?.textContent ?? "";
    expect(concurrencyText).toContain("Concurrent print limit reached");
    expect(concurrencyText).toContain("active print jobs");
    expect(concurrencyText).toContain("This counts jobs waiting or printing now.");
    // The two limits must remain distinguishable in copy and in unit.
    expect(concurrencyText).not.toContain("jobs per minute");
  });

  it("reports an unlimited allowance and stays closed when not opened", () => {
    const body = renderDialog({ open: true, resource: "agents", used: 3, limit: "unlimited" });
    expect(body.textContent ?? "").toContain("Unlimited");

    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    roots = [];
    for (const host of hosts) host.remove();
    hosts = [];
    document.body.innerHTML = "";
    const closedHost = document.createElement("div");
    document.body.appendChild(closedHost);
    const closedRoot = createRoot(closedHost);
    hosts.push(closedHost);
    roots.push(closedRoot);
    act(() => {
      closedRoot.render(h(UpgradeLimitDialog, {
        open: false,
        onClose: () => {},
        resource: "prints",
        used: 1,
        limit: 1,
      }) as never);
    });
    expect((document.body.textContent ?? "").trim()).not.toContain("Print limit reached");
    expect(document.body.querySelector("[data-dialog-root]")).toBeNull();
  });

  it("closes through the modal action", () => {
    const onClose = vi.fn();
    const body = renderDialog({ open: true, used: 10, limit: 10, onClose });
    // The dismiss control is an icon-only button, so it carries no text
    // content — it is identified by its accessible name (aria-label), which is
    // what assistive tech and the a11y contract actually depend on.
    const closeButton = Array.from(body.querySelectorAll('[role="dialog"] button')).find(
      (b) => (b.getAttribute("aria-label") ?? "").trim() === "Close dialog",
    );
    expect(closeButton).toBeDefined();
    act(() => {
      closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
