// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { AppShell } from "../src/components/AppShell";

const route = vi.hoisted(() => ({ pathname: "/login" }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["/login", "/signup", "/platform/login", "/platform/dashboard", "/", "/pricing"])(
  "keeps the page-owned main landmark at the top level on %s", async (pathname) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    route.pathname = pathname;
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(h(AppShell, { children: h("main", null, h("h1", null, "Page content")) })));
    expect(host.querySelectorAll("main")).toHaveLength(1);
    const result = await axe.run(host, {
      runOnly: ["landmark-main-is-top-level", "landmark-no-duplicate-main"],
    });
    expect(result.violations).toEqual([]);
  },
);
