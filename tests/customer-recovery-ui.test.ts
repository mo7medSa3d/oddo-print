// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InvitePage from "../src/app/invite/page";
import OnboardingPage from "../src/app/onboarding/page";
import { I18nProvider } from "../src/i18n/react";
import { fetchWithTimeout } from "../src/lib/fetch-timeout";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), redirect: vi.fn() }));
const invitationQuery = vi.hoisted(() => ({ token: "synthetic-invitation" }));
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/lib/session-config", () => ({ ensureCustomerSession: vi.fn(async () => ({ authenticated: true, expiresAt: Date.now() + 3600000 })) }));
vi.mock("../src/components/AuthShell", () => ({ AuthShell: ({ children }: { children: ReactNode }) => h("main", null, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, redirect: navigation.redirect, useSearchParams: () => new URLSearchParams({ token: invitationQuery.token }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.mocked(fetchWithTimeout);
const response = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => value }) as Response;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  fetchMock.mockReset();
  invitationQuery.token = "synthetic-invitation";
  Object.values(navigation).forEach((fn) => fn.mockReset());
  localStorage.clear();
  document.cookie = "yaseir_locale=en; path=/";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(node: ReactNode, locale: "en" | "ar" = "en") {
  localStorage.setItem("yaseir:locale", locale);
  document.cookie = `yaseir_locale=${locale}; path=/`;
  await act(async () => { root.render(h(I18nProvider, { initialLocale: locale, children: node })); });
}

function button(label: string, within: ParentNode = document) {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  expect(result, `Missing button ${label}`).toBeDefined();
  return result!;
}

describe("customer recovery feedback", () => {
  it("clears the previous invitee when navigating to an invalid invitation", async () => {
    fetchMock.mockResolvedValue(response(200, { email: "first@example.invalid", workspaceName: "First workspace", role: "admin" }));
    await render(h(InvitePage));
    expect(host.textContent).toContain("first@example.invalid");
    invitationQuery.token = "expired-invitation";
    fetchMock.mockResolvedValue(response(404, {}));
    await render(h(InvitePage));
    expect(host.textContent).not.toContain("first@example.invalid");
    expect(host.textContent).not.toContain("First workspace");
    expect([...host.querySelectorAll("button")].some(node => node.textContent === "Accept invitation")).toBe(false);
  });

  it("allows accepting a new invitation after the previous invitation was accepted", async () => {
    fetchMock.mockImplementation(async (_url, init) => init?.method === "POST"
      ? response(200, { ok: true })
      : response(200, { email: "first@example.invalid", workspaceName: "First workspace", role: "admin" }));
    await render(h(InvitePage));
    await act(async () => button("Accept invitation", host).click());
    expect(host.textContent).toContain("Invitation accepted");
    invitationQuery.token = "second-invitation";
    fetchMock.mockResolvedValue(response(200, { email: "second@example.invalid", workspaceName: "Second workspace", role: "admin" }));
    await render(h(InvitePage));
    expect(host.textContent).toContain("second@example.invalid");
    expect(button("Accept invitation", host)).toBeDefined();
    expect(host.textContent).not.toContain("Invitation accepted");
  });
  it.each(["en", "ar"] as const)("does not claim an invitation was accepted when sign-in is still required (%s)", async (locale) => {
    fetchMock.mockImplementation(async (_url, init) => init?.method === "POST"
      ? response(403, { code: "SIGN_IN_REQUIRED" })
      : response(200, { email: "invitee@example.invalid", workspaceName: "Synthetic café", role: "viewer" }));
    await render(h(InvitePage), locale);
    await act(async () => button(locale === "en" ? "Accept invitation" : "قبول الدعوة").click());
    const feedback = host.querySelector('[role="status"]')!;
    expect(feedback.textContent).not.toContain(locale === "en" ? "Invitation accepted" : "تم قبول الدعوة");
    expect(feedback.textContent).toContain(locale === "en" ? "Sign in" : "تسجيل الدخول");
    expect(feedback.querySelector("a")?.getAttribute("href")).toBe("/login?next=%2Finvite%3Ftoken%3Dsynthetic-invitation&switch=1");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

 });


describe("legacy workspace onboarding routes into customer subscription management", () => {
  it.each(["en", "ar"] as const)("redirects the %s workspace member to billing without platform API requests", async locale => {
    await render(h(OnboardingPage), locale);
    expect(navigation.redirect).toHaveBeenCalledWith("/billing");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector("form")).toBeNull();
  });
});
