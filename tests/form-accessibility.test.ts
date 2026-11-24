// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Field, Input, Select } from "../src/components/ui";

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

describe("shared form accessibility", () => {
  it("associates an error with an invalid input", () => {
    const view = render(
      h(Field, {
        label: "Email",
        error: "Enter a valid email",
        children: h(Input, { type: "email" }),
      })
    );
    const input = view.querySelector("input")!;
    const label = view.querySelector("label")!;
    const error = view.querySelector("p")!;

    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("associates a hint with a select without marking it invalid", () => {
    const view = render(
      h(Field, {
        label: "Role",
        hint: "Choose the least privileged role.",
        children: h(Select, null, h("option", null, "viewer")),
      })
    );
    const select = view.querySelector("select")!;
    const hint = view.querySelector("p")!;

    expect(select.hasAttribute("aria-invalid")).toBe(false);
    expect(select.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("preserves caller-provided accessibility attributes", () => {
    const view = render(
      h(Field, {
        label: "Name",
        error: "Required",
        children: h(Input, {
          id: "custom-control",
          "aria-invalid": "false",
          "aria-describedby": "custom-description",
        }),
      })
    );
    const input = view.querySelector("input")!;

    expect(input.id).toBe("custom-control");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBe("custom-description");
  });
});
