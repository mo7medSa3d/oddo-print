// @vitest-environment jsdom
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/components/ui", () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => h("button", { disabled }, children),
  Callout: ({ children }: { children: ReactNode }) => h("div", null, children),
  StatusBadge: ({ label }: { label: string }) => h("span", null, label),
  ConfirmDialog: () => null,
}));

import { BillingActions } from "../src/components/BillingActions";

describe("billing controls match recoverable subscription states", () => {
  it.each(["en", "ar"] as const)("offers paused Stripe subscription recovery without claiming runtime access (%s)", (locale) => {
    const markup = renderToStaticMarkup(h(I18nProvider, { initialLocale: locale,
      children: h(BillingActions, { hasSubscription: false, cancelAtPeriodEnd: false, subscriptionStatus: "paused", canOpenPortal: true }),
    }));
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const buttons = [...doc.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(markup).toContain(locale === "en" ? "Resume subscription" : "استئناف الاشتراك");
  });

  it("does not offer a provider resume operation for an unlinked or terminal subscription", () => {
    for (const subscriptionStatus of ["paused", "cancelled", "incomplete_expired"]) {
      const markup = renderToStaticMarkup(h(I18nProvider, { initialLocale: "en",
        children: h(BillingActions, { hasSubscription: false, cancelAtPeriodEnd: false, subscriptionStatus }),
      }));
      expect(markup).not.toContain("Resume subscription");
    }
  });
});
