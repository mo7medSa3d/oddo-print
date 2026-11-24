// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SubscriptionEditor, type ManualSubscription, type PendingSubscriptionRequest,
} from "../src/components/platform/SubscriptionEditor";
import { I18nProvider } from "../src/i18n/react";
import { LOCALE_COOKIE_KEY, LOCALE_STORAGE_KEY, type Locale } from "../src/i18n/config";
import { translate, type MessageKey } from "../src/i18n/translate";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;

const currentSubscription: ManualSubscription = {
  planId: "annual", planName: "Annual plan", status: "active", effectiveStatus: "active",
  subscriptionType: "paid", monthlyQuota: 100, term: "yearly",
  currentPeriodStart: "2026-01-31T00:00:00.000Z",
  currentPeriodEnd: "2028-01-31T00:00:00.000Z", cancelAtPeriodEnd: false,
  internalReference: null, revision: 2, monthlyUsed: 14, nextReset: "2026-11-01T00:00:00.000Z",
};
const plans = [
  { id: "annual", name: "Annual plan", description: "", entitlements: { max_prints_per_period: 100 }, isActive: true, isPublic: true, displayOrder: 0 },
  { id: "requested", name: "Requested plan", description: "", entitlements: { max_prints_per_period: 250 }, isActive: true, isPublic: true, displayOrder: 1 },
];
const request: PendingSubscriptionRequest = {
  id: "req_customer_choice", planId: "requested", term: "yearly", requestedMonthlyQuota: 250,
  status: "pending", requesterName: "Workspace owner", requesterEmail: "owner@example.test", createdAt: "2026-10-27T00:00:00Z",
};

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host.remove();
});

const labelText = (locale: Locale, key: string) =>
  translate(locale, ("v4.admin." + key) as MessageKey);
function input(locale: Locale, key: string) {
  const label = [...host.querySelectorAll<HTMLLabelElement>("label")]
    .find(node => node.querySelector("span")?.textContent === labelText(locale, key));
  return (label?.querySelector("select,input,textarea") ?? null) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
}
function choose(node: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(node).not.toBeNull();
  act(() => {
    node!.value = value;
    node!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function press(locale: Locale, key: string) {
  const label = labelText(locale, key);
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent?.trim() === label);
  expect(button, "Missing button " + label).toBeDefined();
  act(() => { button!.click(); });
}
function reveal(locale: Locale, key: string) {
  const details = [...host.querySelectorAll<HTMLDetailsElement>("details")]
    .find(node => node.querySelector("summary")?.textContent === labelText(locale, key));
  expect(details, "Missing collapsed " + key).toBeDefined();
  act(() => { details!.open = true; });
  return details!;
}
function renderEditor(locale: Locale, subscription: ManualSubscription | null = currentSubscription,
  pendingRequest?: PendingSubscriptionRequest, preferredAction?: "revoke") {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.cookie = LOCALE_COOKIE_KEY + "=" + locale + "; path=/";
  root = createRoot(host);
  act(() => root!.render(h(I18nProvider, {
    initialLocale: locale,
    children: h(SubscriptionEditor, {
      tenantId: "workspace", subscription, request: pendingRequest, preferredAction, plans,
      onSaved: () => undefined,
    }),
  })));
}

describe("minimal, contextual subscription editor", () => {
  it.each(["en", "ar"] as const)("shows just plan and quota by default for an active %s subscription", locale => {
    renderEditor(locale);
    expect(input(locale, "plan")?.value).toBe("annual");
    expect(input(locale, "quota")?.value).toBe("100");
    expect(input(locale, "action")).toBeNull();
    expect(input(locale, "status")).toBeNull();
    expect(input(locale, "term")).toBeNull();
    expect(input(locale, "start")).toBeNull();
    expect(input(locale, "end")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    const optional = [...host.querySelectorAll("details")]
      .find(node => node.querySelector("summary")?.textContent === labelText(locale, "optionalDetails"));
    expect(optional?.open).toBe(false);
    const more = [...host.querySelectorAll("details")]
      .find(node => node.querySelector("summary")?.textContent === labelText(locale, "manageExtraActions"));
    expect(more?.open).toBe(false);
  });

  it.each(["en", "ar"] as const)("renews from existing expiry and only exposes dates for a custom %s term", locale => {
    renderEditor(locale);
    reveal(locale, "manageExtraActions");
    press(locale, "renew");
    expect(input(locale, "term")?.value).toBe("yearly");
    expect(input(locale, "end")).toBeNull();
    expect(host.querySelector('time[datetime="2029-01-31"]')).not.toBeNull();

    choose(input(locale, "term"), "monthly");
    expect(host.querySelector('time[datetime="2028-02-29"]')).not.toBeNull();
    choose(input(locale, "term"), "yearly");
    expect(host.querySelector('time[datetime="2029-01-31"]')).not.toBeNull();
    choose(input(locale, "term"), "custom");
    expect(input(locale, "end")?.value).toBe("2029-01-31");
    expect(input(locale, "start")).toBeNull();
  });

  it.each(["en", "ar"] as const)("keeps request details locked without repeating activation status in %s", locale => {
    renderEditor(locale, null, request);
    expect(input(locale, "plan")?.value).toBe("requested");
    expect(input(locale, "plan")?.disabled).toBe(true);
    expect(input(locale, "quota")?.value).toBe("250");
    expect(input(locale, "quota")?.disabled).toBe(true);
    expect(input(locale, "term")?.value).toBe("yearly");
    expect(input(locale, "term")?.disabled).toBe(true);
    expect(input(locale, "status")).toBeNull();
    expect(input(locale, "action")).toBeNull();
    expect(host.textContent).not.toContain(request.id);
    press(locale, "preview");
    expect(input(locale, "reason")?.tagName).toBe("TEXTAREA");
    expect(input(locale, "password")).toBeNull();
    expect(host.textContent).toContain(labelText(locale, "activateRequested"));
  });

  it.each(["en", "ar"] as const)("defers the administrative reason until the final %s step", locale => {
    renderEditor(locale, null);
    expect(input(locale, "term")?.value).toBe("monthly");
    expect(input(locale, "end")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    const advanced = reveal(locale, "optionalDetails");
    expect(advanced.querySelector('input[type="date"]')).not.toBeNull();
    choose(input(locale, "term"), "custom");
    expect(input(locale, "end")?.getAttribute("type")).toBe("date");
    press(locale, "preview");
    expect(input(locale, "reason")).not.toBeNull();
    expect(input(locale, "password")).toBeNull();
    expect(input(locale, "status")).toBeNull();
  });

  it.each(["en", "ar"] as const)("separates suspension from plan editing and demands a confirmation in %s", locale => {
    renderEditor(locale);
    reveal(locale, "manageExtraActions");
    press(locale, "suspend");
    expect(input(locale, "plan")).toBeNull();
    expect(input(locale, "reason")).not.toBeNull();
    expect(input(locale, "password")).toBeNull();
    expect(host.textContent).toContain(labelText(locale, "suspend"));
  });

  it.each(["en", "ar"] as const)("does not offer reactivation without finite expiry in %s", locale => {
    renderEditor(locale, {...currentSubscription, status: "suspended", effectiveStatus: "suspended", currentPeriodEnd: null, canReactivate: false});
    expect(host.textContent).not.toContain(labelText(locale, "reactivate"));
  });

  it.each(["en", "ar"] as const)("does not offer reactivation after same-day expiry in %s", locale => {
    renderEditor(locale, {...currentSubscription, status: "suspended", effectiveStatus: "suspended",
      currentPeriodEnd: new Date(Date.now() - 60_000).toISOString(), canReactivate: false});
    expect(host.textContent).not.toContain(labelText(locale, "reactivate"));
  });

  it.each(["en", "ar"] as const)("does not invent reactivation from a future date without Gateway confirmation in %s", locale => {
    renderEditor(locale, {...currentSubscription, status: "suspended", effectiveStatus: "suspended",
      currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(), canReactivate: false});
    expect(host.textContent).not.toContain(labelText(locale, "reactivate"));
  });

  it.each(["en", "ar"] as const)("offers reactivation for a future finite expiry in %s", locale => {
    renderEditor(locale, {...currentSubscription, status: "suspended", effectiveStatus: "suspended",
      currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(), canReactivate: true});
    expect(host.textContent).toContain(labelText(locale, "reactivate"));
  });

  it.each(["en", "ar"] as const)("never carries a renewal expiry back into a plan-only edit in %s", locale => {
    renderEditor(locale);
    reveal(locale, "manageExtraActions");
    press(locale, "renew");
    expect(host.querySelector('time[datetime="2029-01-31"]')).not.toBeNull();
    press(locale, "updatePlan");
    expect(input(locale, "term")).toBeNull();
    press(locale, "preview");
    expect(host.querySelector('time[datetime="2028-01-31"]')).not.toBeNull();
    expect(host.querySelector('time[datetime="2029-01-31"]')).toBeNull();
  });

  it.each(["en","ar"] as const)("labels new subscription timing as approval-based instead of a stale date in %s", locale => {
    renderEditor(locale, null, request);
    expect(host.textContent).toContain(labelText(locale, "approvalDateNotice"));
    press(locale, "preview");
    expect(host.textContent).toContain(labelText(locale, "startsAtApproval"));
    expect(host.textContent).toContain(labelText(locale, "endsFromApproval"));
    expect(host.querySelector('time[datetime="2026-10-27"]')).toBeNull();
  });

  it.each(["en","ar"] as const)("does not replace a monthly Go request with an existing yearly subscription in %s",locale=>{
    renderEditor(locale,currentSubscription,{...request,term:"monthly",planId:"requested",requestedMonthlyQuota:250});
    expect(input(locale,"plan")?.value).toBe("requested");
    expect(input(locale,"term")?.value).toBe("monthly");
    expect(input(locale,"term")?.disabled).toBe(true);
    expect(host.textContent).toContain(labelText(locale,"activateRequested"));
    expect(host.textContent).not.toContain(labelText(locale,"renewRequested"));
    press(locale,"preview");
    expect(host.textContent).toContain(labelText(locale,"monthly"));
    // A linked approval cannot advertise client-side form dates as contractual.
    expect(host.textContent).toContain(labelText(locale, "startsAtApproval"));
    expect(host.textContent).toContain(labelText(locale, "endsFromApproval"));
    expect(host.textContent).not.toContain("—");
  });

  it.each(["en","ar"] as const)("allows an explicit, audited admin change while keeping original monthly request visible in %s",locale=>{
    renderEditor(locale,currentSubscription,{...request,term:"monthly"});
    press(locale,"adjustRequestTerms");
    expect(input(locale,"term")?.disabled).toBe(false);
    choose(input(locale,"term"),"yearly");
    press(locale,"preview");
    expect(host.textContent).toContain(labelText(locale,"monthly"));
    expect(host.textContent).toContain(labelText(locale,"yearly"));
    expect(host.textContent).toContain(labelText(locale,"requestedTerms"));
    expect(host.textContent).toContain(labelText(locale,"approvedTerms"));
  });


  it.each(["en","ar"] as const)("opens a safe revoke preview from the admin subscription shortcut in %s", locale=>{
    renderEditor(locale, currentSubscription, undefined, "revoke");
    expect(input(locale,"plan")).toBeNull();
    expect(input(locale,"password")).toBeNull();
    expect(host.textContent).toContain(labelText(locale,"revoke"));
    press(locale,"preview");
    expect(input(locale,"reason")).not.toBeNull();
    expect(input(locale,"password")).toBeNull();
    expect(host.textContent).toContain(labelText(locale,"endSubscriptionWarning"));
  });
});
