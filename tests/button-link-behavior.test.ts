// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "../src/components/ui";

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

describe("shared Button link behavior", () => {
  it("preserves onClick for enabled links", () => {
    const onClick = vi.fn() as React.MouseEventHandler<HTMLButtonElement>;
    const view = render(React.createElement(Button, { href: "/dashboard", onClick, title: "Open dashboard" }, "Open"));
    const link = view.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/dashboard");
    expect(link.getAttribute("title")).toBe("Open dashboard");

    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks navigation while loading or disabled", () => {
    for (const props of [{ loading: true }, { disabled: true }]) {
      const onClick = vi.fn();
      const view = render(React.createElement(Button, { href: "/dashboard", onClick, ...props }, "Open"));
      const link = view.querySelector("a")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(onClick).not.toHaveBeenCalled();
      expect(link.getAttribute("aria-disabled")).toBe("true");
      expect(link.getAttribute("tabindex")).toBe("-1");
    }
  });
});
