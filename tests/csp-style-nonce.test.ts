// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stylesheetSingleton } from "react-style-singleton";
import { getNonce, setNonce } from "get-nonce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CspStyleNonce } from "../src/components/CspStyleNonce";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let initialScript: HTMLScriptElement | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setNonce("");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  initialScript?.remove();
  setNonce("");
  root = undefined;
  host = undefined;
  initialScript = undefined;
  vi.unstubAllGlobals();
});

describe("CSP runtime style nonce", () => {
  it("uses the document CSP nonce rather than a later client-navigation nonce", () => {
    initialScript = document.createElement("script");
    initialScript.nonce = "initial-document-nonce";
    document.head.appendChild(initialScript);

    act(() => root!.render(h(CspStyleNonce, { nonce: "later-rsc-request-nonce" })));
    expect(getNonce()).toBe("initial-document-nonce");

    act(() => root!.render(h(CspStyleNonce, { nonce: "yet-another-rsc-nonce" })));
    expect(getNonce()).toBe("initial-document-nonce");
  });

  it("falls back to its server nonce when there is no existing nonce-bearing script", () => {
    act(() => root!.render(h(CspStyleNonce, { nonce: "server-nonce" })));
    expect(getNonce()).toBe("server-nonce");
  });

  it("gives react-remove-scroll's stylesheet injector the active document nonce", () => {
    initialScript = document.createElement("script");
    initialScript.nonce = "modal-csp-nonce";
    document.head.appendChild(initialScript);
    act(() => root!.render(h(CspStyleNonce, { nonce: "later-request-nonce" })));

    // react-remove-scroll (used by Radix Dialog) uses this exact package's
    // stylesheetSingleton.add() to dynamically insert its scroll-lock CSS.
    const injectedStyle = stylesheetSingleton();
    try {
      injectedStyle.add("body[data-csp-test] { overflow: hidden; }");
      const matching = [...document.head.querySelectorAll<HTMLStyleElement>("style")]
        .filter((style) => style.textContent?.includes("body[data-csp-test]"));
      expect(matching).toHaveLength(1);
      expect(matching[0]?.nonce).toBe("modal-csp-nonce");
    } finally {
      injectedStyle.remove();
    }
  });
});
