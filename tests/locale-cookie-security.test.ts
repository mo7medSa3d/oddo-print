// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
// Keep React's test renderer/runtime in development mode while the application
// configuration is reloaded under each production/development cookie policy.
import "react/jsx-dev-runtime";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverCookieValues = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => {
    const value = serverCookieValues.get(name);
    return value === undefined ? undefined : { value };
  } }),
}));

let root: Root | null = null;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  serverCookieValues.clear();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Execute the actual inline source delivered by RootLayout, before React. */
async function prepaint(cookie: string, stored: string | null = null) {
  const config = await import("../src/i18n/config");
  const source = readFileSync("src/app/layout.tsx", "utf8");
  const expression = source.match(/const LOCALE_INIT = (`[^`]*`);/);
  expect(expression, "RootLayout keeps the tested inline bootstrap").not.toBeNull();
  const script = runInNewContext(expression![1], {
    LOCALE_COOKIE_KEY: config.LOCALE_COOKIE_KEY,
    LOCALE_STORAGE_KEY: config.LOCALE_STORAGE_KEY,
    JSON,
  });
  const element = { lang: "", dir: "" };
  runInNewContext(script, {
    localStorage: { getItem: (key: string) => key === config.LOCALE_STORAGE_KEY ? stored : null },
    document: { cookie, documentElement: element },
  });
  return element;
}

async function renderLocale(cookie: string) {
  vi.spyOn(document, "cookie", "get").mockReturnValue(cookie);
  const writes: string[] = [];
  vi.spyOn(document, "cookie", "set").mockImplementation(value => { writes.push(value); });
  const { I18nProvider, useI18n } = await import("../src/i18n/react");
  function Probe() {
    const { locale, setLocale } = useI18n();
    return h("button", { onClick: () => setLocale("ar") }, locale);
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(h(I18nProvider, { initialLocale: "en", children: h(Probe) })));
  return { button: host.querySelector("button")!, writes };
}

describe("locale cookie production cutover", () => {
  it("uses a production host-prefixed name in the shared configuration", async () => {
    expect((await import("../src/i18n/config")).LOCALE_COOKIE_KEY).toBe("__Host-yaseir_locale");
  });

  it("ignores a hostile unprefixed cookie before the first paint", async () => {
    expect(await prepaint("yaseir_locale=ar")).toEqual({ lang: "en", dir: "ltr" });
    expect(await prepaint("yaseir_locale=en; __Host-yaseir_locale=ar")).toEqual({ lang: "ar", dir: "rtl" });
    expect(await prepaint("__Host-yaseir_locale=arabic")).toEqual({ lang: "en", dir: "ltr" });
  });

  it("keeps the stored desktop preference when cookies are absent", async () => {
    expect(await prepaint("", "ar")).toEqual({ lang: "ar", dir: "rtl" });
    expect(await prepaint("__Host-yaseir_locale=ar", "en")).toEqual({ lang: "en", dir: "ltr" });
  });

  it("uses only the production name for server-rendered locale", async () => {
    const { getServerLocale } = await import("../src/i18n/server");
    serverCookieValues.set("yaseir_locale", "ar");
    expect(await getServerLocale()).toBe("en");
    serverCookieValues.set("__Host-yaseir_locale", "ar");
    expect(await getServerLocale()).toBe("ar");
  });

  it("reads the protected cookie in React without accepting the legacy value", async () => {
    const { button } = await renderLocale("yaseir_locale=en; __Host-yaseir_locale=ar");
    expect(button.textContent).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("writes a Secure host cookie and expires the old host cookie on language choice", async () => {
    const { button, writes } = await renderLocale("yaseir_locale=ar");
    expect(button.textContent).toBe("en");
    act(() => button.click());
    expect(localStorage.getItem("yaseir:locale")).toBe("ar");
    expect(button.textContent).toBe("ar");
    const current = writes.find(value => value.startsWith("__Host-yaseir_locale=ar;"));
    expect(current).toBeDefined();
    expect(current).toMatch(/;\s*path=\//i);
    expect(current).toMatch(/;\s*secure(?:;|$)/i);
    expect(current).toMatch(/;\s*samesite=lax(?:;|$)/i);
    expect(current).toMatch(/;\s*max-age=31536000(?:;|$)/i);
    expect(current).not.toMatch(/;\s*domain=/i);
    expect(writes).toContainEqual(expect.stringMatching(/^yaseir_locale=;.*max-age=0/i));
  });

  it("retains localStorage and the active preference when desktop cookies are unavailable", async () => {
    const { button } = await renderLocale("");
    vi.spyOn(document, "cookie", "set").mockImplementation(() => { throw new Error("opaque desktop origin"); });
    act(() => button.click());
    expect(localStorage.getItem("yaseir:locale")).toBe("ar");
    expect(button.textContent).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("preserves the development HTTP cookie name and attributes", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await import("../src/i18n/config")).LOCALE_COOKIE_KEY).toBe("yaseir_locale");
    expect(await prepaint("yaseir_locale=ar")).toEqual({ lang: "ar", dir: "rtl" });
    const { button, writes } = await renderLocale("");
    act(() => button.click());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^yaseir_locale=ar;/);
    expect(writes[0]).not.toMatch(/;\s*secure(?:;|$)/i);
  });
});
