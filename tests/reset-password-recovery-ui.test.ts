// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResetPassword from "../src/app/reset-password/page";
import { I18nProvider } from "../src/i18n/react";
import { fetchWithTimeout } from "../src/lib/fetch-timeout";

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, useSearchParams: () => new URLSearchParams(navigation.search) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));
vi.mock("../src/components/AuthShell", () => ({ AuthShell: ({ children }: { children: ReactNode }) => h("main", null, children) }));
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: vi.fn() }));

const fetchMock = vi.mocked(fetchWithTimeout);
const token = "synthetic-expired-email-proof";
const password = "  Synthetic recovery password إعادة  \t";
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock.mockReset(); navigation.replace.mockReset(); navigation.search = "";
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function render(locale: "en" | "ar") {
  localStorage.setItem("yaseir:locale", locale); document.cookie = `yaseir_locale=${locale}; path=/`;
  window.history.replaceState({}, "", `/reset-password?${navigation.search}`);
  await act(async () => root.render(h(I18nProvider, { initialLocale: locale, children: h(ResetPassword) })));
}
async function submit() {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>("#password")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, password);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
function recoveryLink(locale: "en" | "ar") {
  const link = host.querySelector<HTMLAnchorElement>("#request-new-reset-link");
  expect(link, "An expired or missing reset/setup proof needs an explicit replacement path").not.toBeNull();
  expect(link!.textContent).toBe(locale === "en" ? "Request a new password reset link" : "طلب رابط جديد لإعادة تعيين كلمة المرور");
  expect(link!.getAttribute("href")).toBe("/forgot-password");
  const destination = new URL(link!.href);
  expect(destination.origin).toBe(window.location.origin);
  expect(destination.search).toBe(""); expect(destination.hash).toBe("");
  expect(link!.href).not.toContain(token); expect(link!.href).not.toContain(password);
  return link!;
}

describe("explicit recovery from expired email authentication links", () => {
  it("shows a fresh form when navigating from a completed reset to another reset link", async () => {
    navigation.search = "token=first-reset";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    await render("en");
    await submit();
    expect(host.querySelector("form")).toBeNull();
    navigation.search = "token=second-reset";
    await render("en");
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>("#password")?.value).toBe("");
    expect(navigation.replace).not.toHaveBeenCalled();
  });
  it.each([
    ["en", false], ["ar", false], ["en", true], ["ar", true],
  ] as const)("offers a localized fresh-link route after an expired proof without replay (%s, setup=%s)", async (locale, setup) => {
    navigation.search = `token=${token}${setup ? "&setup=1&joined=1&plan=synthetic-plan" : ""}`;
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Reset link expired or invalid" }) } as Response);
    await render(locale);
    expect(fetchMock).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/reset-password");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ token, password });
    expect(host.textContent).toContain(locale === "en" ? "We couldn’t reset the password" : "تعذّرت إعادة تعيين كلمة المرور");
    expect(host.textContent).not.toContain("Reset link expired or invalid");
    expect(host.querySelector("form")).not.toBeNull();
    const link = recoveryLink(locale);
    // Keep jsdom on the page; native navigation remains the only link behavior.
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    await act(async () => link.click());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(navigation.replace).not.toHaveBeenCalled();
    const storage = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    expect(storage).not.toContain(token); expect(storage).not.toContain(password);
  });

  it.each(["en", "ar"] as const)("offers the same explicit recovery route for a missing proof without an API request (%s)", async locale => {
    navigation.search = "setup=1";
    await render(locale); await submit();
    recoveryLink(locale);
    expect(fetchMock).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
    expect(host.textContent).toContain(locale === "en" ? "Request a new one from the sign-in page" : "اطلب رابطًا جديدًا من صفحة تسجيل الدخول");
  });
});
