// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { Tooltip, Field, Input } from "../src/components/ui";

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

// H-5: automated accessibility backstop for shared UI primitives. Runs
// color-contrast, label, and ARIA rules; icon-only and overlay components
// must not regress silently (lint has no jsx-a11y plugin).
describe("shared UI accessibility (H-5)", () => {
  it("has no axe violations on labelled field + tooltip primitives", async () => {
    const view = render(
      h("div", null,
        h(Field, { label: "Printer", children: h(Input, { type: "text", "aria-label": "Printer" }) }),
        h(Tooltip, { label: "Retry the print", children: h("button", { type: "button", children: "Retry" }) }),
      ),
    );
    const results = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}:${v.nodes.length}`)).toEqual([]);
  }, 30000);
});
