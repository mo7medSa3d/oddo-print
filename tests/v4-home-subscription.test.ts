// @vitest-environment jsdom
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { translate } from "../src/i18n/translate";
import { roleLabel } from "../src/lib/roles";

const fixture = vi.hoisted(() => ({
  authenticated: true, role: "owner", lifecycle: "active", locale: "en" as "ar" | "en",
  now: Date.parse("2030-05-15T00:00:00Z"), subscription: null as Record<string, unknown> | null,
  planReads: 0,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => ({ value: name === "yaseir_locale" ? fixture.locale : "session" }) }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/lib/manager-auth", () => ({
  getManagerCookieName: () => "mgr_session",
  verifyWorkspaceTokenFromCookieValues: async () => fixture.authenticated ? { tenantId: "home-tenant", role: fixture.role } : null,
}));
vi.mock("../src/lib/database-clock", () => ({
  databaseNowMs: async () => fixture.now,
  refreshClockSkew: async () => 0,
  gatewayNowMs: () => fixture.now,
}));
vi.mock("../src/db", () => {
  const query = {
    tenants: { findFirst: async () => ({ name: "Home workspace", lifecycle: fixture.lifecycle }) },
    tenantSubscriptions: { findFirst: async () => fixture.subscription },
    plans: { findFirst: async () => { fixture.planReads += 1; return { name: "Private contract title" }; } },
  };
  return { db: { query, transaction: async (callback: (tx: { query: typeof query }) => Promise<unknown>) =>
    callback({ query }) } };
});

vi.mock("../src/lib/tenant-guard", () => ({
  requireActiveTenantInTransaction: async () => {},
  TenantSuspendedError: class TenantSuspendedError extends Error {},
  TenantDeletedError: class TenantDeletedError extends Error {},
}));
vi.mock("../src/lib/manager-mutation-authorization", () => ({
  requireManagerActorInTransaction: async () => {},
  ManagerMutationAuthorityChangedError: class ManagerMutationAuthorityChangedError extends Error {},
}));

import Home from "../src/app/page";

beforeEach(() => {
  localStorage.clear(); fixture.authenticated = true; fixture.role = "owner"; fixture.lifecycle = "active";
  fixture.locale = "en"; fixture.planReads = 0; document.cookie = "yaseir_locale=en; path=/";
  fixture.subscription = { planId: "private", status: "active", billingMode: "manual", entitlementBlocked: false,
    currentPeriodStart: new Date("2030-01-01T00:00:00Z"), currentPeriodEnd: new Date("2031-01-01T00:00:00Z") };
});
afterEach(() => { vi.restoreAllMocks(); });

async function render(locale: "en" | "ar" = "en") {
  fixture.locale = locale; document.cookie = `yaseir_locale=${locale}; path=/`;
  return new DOMParser().parseFromString(renderToStaticMarkup(h(I18nProvider, { initialLocale: locale, children: await Home() })), "text/html");
}
function valueFor(doc: Document, key: Parameters<typeof translate>[1], locale = fixture.locale) {
  return [...doc.querySelectorAll("dt")].find(node => node.textContent === translate(locale, key))?.nextElementSibling?.textContent;
}

describe("manual subscription truth on Home", () => {
  it.each(["en", "ar"] as const)("shows owner-facing subscription details in %s without taking the user to Platform Admin", async locale => {
    const doc = await render(locale);
    expect(valueFor(doc, "home.subscriptionLabel")).toBe(translate(locale, "v4.onboarding.active"));
    expect(valueFor(doc, "home.planLabel")).toBe("Private contract title");
    expect(fixture.planReads).toBe(1);
    expect(valueFor(doc, "v4.subscription.end")).toBeTruthy();
    expect(doc.querySelector('a[href="/billing"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/platform/subscriptions"]')).toBeNull();
  });

  it("does not claim active access before a scheduled start, using database time instead of the host clock", async () => {
    fixture.subscription!.currentPeriodStart = "2030-05-16 00:00:00";
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2040-01-01T00:00:00Z"));
    const doc = await render();
    expect(valueFor(doc, "home.subscriptionLabel")).toBe(translate("en", "v4.onboarding.pending"));
    expect(valueFor(doc, "home.planLabel")).toBe(translate("en", "billing.noPlanSelected"));
  });

  it.each(["missing", "awaiting_activation", "expired", "suspended", "blocked", "tenant_suspended"])("renders %s in Arabic without provider wording or raw state identifiers", async state => {
    let expected: "v4.onboarding.pending" | "v4.onboarding.expired" | "v4.onboarding.suspended" = "v4.onboarding.pending";
    if (state === "missing") fixture.subscription = null;
    else if (state === "expired") { fixture.subscription!.currentPeriodEnd = "2030-05-15 00:00:00"; expected = "v4.onboarding.expired"; }
    else if (state === "blocked") { fixture.subscription!.entitlementBlocked = true; expected = "v4.onboarding.suspended"; }
    else if (state === "tenant_suspended") { fixture.lifecycle = "suspended"; expected = "v4.onboarding.suspended"; }
    else { fixture.subscription!.status = state; if (state === "suspended") expected = "v4.onboarding.suspended"; }
    const doc = await render("ar");
    expect(valueFor(doc, "home.subscriptionLabel")).toBe(translate("ar", expected));
    expect(doc.body.textContent).not.toContain(translate("ar", "billing.paymentAttention"));
    expect(doc.body.textContent).not.toMatch(/Awaiting Activation|Expired|Suspended|trialing|past_due/);
  });

  it.each(["viewer", "operator", "integration_admin"])("does not fetch or disclose plan and contract metadata to %s", async role => {
    fixture.role = role; const doc = await render("ar");
    expect(fixture.planReads).toBe(0);
    expect(doc.body.textContent).not.toContain("Private contract title");
    expect(valueFor(doc, "home.planLabel")).toBeUndefined();
    expect(valueFor(doc, "v4.subscription.end")).toBeUndefined();
    expect(doc.querySelector('a[href="/billing"]')).toBeNull();
    expect(valueFor(doc, "home.subscriptionLabel")).toBe(translate("ar", "v4.onboarding.active"));
  });

  it.each(["admin", "billing_admin"])("shows %s as Full Access without customer billing authority", async role => {
    fixture.role = role; const doc = await render("ar");
    expect(doc.body.textContent).toContain(roleLabel(role, (key, params) => translate("ar", key, params)));
    expect(valueFor(doc, "home.planLabel")).toBeUndefined();
    expect(fixture.planReads).toBe(0);
    expect(doc.querySelector('a[href="/billing"]')).toBeNull();
  });

  it.each(["en", "ar"] as const)("invites public visitors to create a workspace without promising an automatic trial in %s", async locale => {
    fixture.authenticated = false; const doc = await render(locale);
    const signupLinks = [...doc.querySelectorAll('a[href="/signup"]')];
    expect(signupLinks.length).toBeGreaterThan(1);
    expect(signupLinks.some(node => node.textContent?.includes(translate(locale, "home.ctaPrimary")))).toBe(true);
    expect(doc.body.textContent).not.toMatch(/free trial|Start trial|فترتك التجريبية|ابدأ التجربة/i);
    const flow = doc.querySelector("#how-it-works")!;
    const headings = [...flow.querySelectorAll("h3")].map(node => node.textContent);
    expect(headings).toContain(translate(locale, "home.visualStep1Title"));
    expect(headings).toContain(translate(locale, "home.visualStep2Title"));
    if (locale === "ar") expect(headings.join(" ")).not.toMatch(/Odoo|Gateway/);
  });
});
