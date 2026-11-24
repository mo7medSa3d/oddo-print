// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VerifyEmailPage from "../src/app/verify-email/page";
import { I18nProvider } from "../src/i18n/react";
import { translate } from "../src/i18n/translate";
import { fetchWithTimeout } from "../src/lib/fetch-timeout";

const fixture = vi.hoisted(() => ({ search: "", router: { replace: vi.fn() } }));
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/components/AuthShell", () => ({ AuthShell: ({ children, title, description }: { children: ReactNode; title: string; description: string }) => h("main", null, h("h1", null, title), h("p", null, description), children) }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, useSearchParams: () => new URLSearchParams(fixture.search) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(fetchWithTimeout).mockReset();
  fixture.router.replace.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("email verification network feedback", () => {
  it("updates the resend recipient when navigating to a different email confirmation link", async () => {
    fixture.search = "email=first%40example.invalid";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const content = () => h(I18nProvider, { initialLocale: "en", children: h(VerifyEmailPage) });
    try {
      await act(async () => root.render(content()));
      expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe("first@example.invalid");
      fixture.search = "email=second%40example.invalid";
      await act(async () => root.render(content()));
      expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe("second@example.invalid");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it.each(["en", "ar"] as const)("keeps verification and resend failures localized and permits resend recovery (%s)", async locale => {
    document.cookie = `yaseir_locale=${locale}; path=/`;
    localStorage.setItem("yaseir:locale", locale);
    fixture.search = `token=synthetic-${locale}&email=synthetic%40example.invalid`;
    const fetchMock = vi.mocked(fetchWithTimeout);
    fetchMock.mockRejectedValue(new Error("Synthetic internal network diagnostic"));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(I18nProvider, { initialLocale: locale, children: h(VerifyEmailPage) })));
      expect(host.textContent).toContain(translate(locale, "auth.verify.failed"));
      expect(host.textContent).not.toContain("Synthetic internal network diagnostic");
      const form = host.querySelector("form")!;
      await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(form.querySelector('[role="alert"]')?.textContent).toBe(translate(locale, "auth.verify.resendFailed"));
      expect(host.textContent).not.toContain("Synthetic internal network diagnostic");
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);
      await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(form.querySelector('[role="status"]')?.textContent).toBe(translate(locale, "auth.verify.resendSent"));
      expect(fixture.router.replace).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/verify-email", "/api/auth/resend-verification", "/api/auth/resend-verification"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
