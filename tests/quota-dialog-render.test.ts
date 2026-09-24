// @vitest-environment jsdom
/**
 * The quota-exhausted dialog must render the exact fields the limit signal
 * carries: which allowance was hit, what was used against what limit, when the
 * current billing period ends, and the upgrade path. This renders the real
 * component (no testing library) instead of asserting on source text.
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
  return host;
}

describe("quota-exhausted upgrade dialog", () => {
  it("renders the billing-period print limit with usage and the upgrade path", () => {
    const host = renderDialog({
      open: true,
      resource: "prints",
      used: 500,
      limit: 500,
      periodEnd: "2026-10-01T00:00:00.000Z",
    });

    const text = host.textContent ?? "";
    expect(text).toContain("Print limit reached");
    expect(text).toContain("used its included print jobs for this billing period");
    expect(text).toContain("Metering unit: 1 admitted Gateway print job = 1 print credit.");
    // Usage must reflect the signal, not a guess.
    expect(text).toContain("500");
    expect(text).toContain("Used");
    expect(text).toContain("Plan limit");
    // The period end is rendered as a date, never as a raw timestamp.
    expect(text).toMatch(/\d{4}/);
    expect(text).not.toContain("2026-10-01T00:00:00.000Z");

    const upgrade = host.querySelector('a[href="/billing"]');
    expect(upgrade).not.toBeNull();
    expect(upgrade?.textContent ?? "").toContain("Upgrade plan");

    // Server-side enforcement is stated explicitly so the user knows retrying
    // cannot bypass the allowance.
    const description = host.querySelector('[id$="-description"], [role="dialog"]')?.textContent ?? "";
    expect(description).toContain("enforces plan limits server-side");
  });

  it("explains a rolling rate limit and a concurrency limit differently", () => {
    const rate = renderDialog({ open: true, resource: "rate", used: 20, limit: 20, retryAfterSeconds: 60 });
    expect(rate.textContent ?? "").toContain("rolling 60-second limit");
    expect(rate.textContent ?? "").toContain("Try again in about 1 minute");

    const concurrency = renderDialog({ open: true, resource: "concurrency", used: 5, limit: 5 });
    expect(concurrency.textContent ?? "").toContain("queued, claimed, and actively printing jobs");
  });

  it("reports an unlimited allowance and stays closed when not opened", () => {
    const unlimited = renderDialog({ open: true, resource: "agents", used: 3, limit: "unlimited" });
    expect(unlimited.textContent ?? "").toContain("Unlimited");

    const closed = renderDialog({ open: false, used: 1, limit: 1 });
    expect((closed.textContent ?? "").trim()).not.toContain("Print limit reached");
  });

  it("closes through the modal action", () => {
    const onClose = vi.fn();
    const host = renderDialog({ open: true, used: 10, limit: 10, onClose });
    const closeButton = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Close");
    expect(closeButton).toBeDefined();
    act(() => {
      closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
