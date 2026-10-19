// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tooltip } from "../src/components/ui";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

describe("tooltip overlay (H-4)", () => {
  it("describes the trigger (not the wrapper) and wraps long labels", () => {
    const view = render(
      h(Tooltip, { label: "تسمية عربية طويلة جدا للاختبار", children: h("button", { type: "button" }, "OK") }),
    );
    const tip = view.querySelector('[role="tooltip"]')!;
    const button = view.querySelector("button")!;
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(view.querySelector("span.group\\/tooltip, span[class*='group/tooltip']")?.getAttribute("aria-describedby")).toBeNull();
    expect(tip.className).toContain("whitespace-normal");
    expect(tip.className).toContain("break-words");
    expect(tip.className).not.toContain("whitespace-nowrap");
  });
});
