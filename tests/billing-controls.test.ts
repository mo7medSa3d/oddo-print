// @vitest-environment jsdom
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { BillingActions, type CustomerSubscriptionRequest } from "../src/components/BillingActions";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const fetchMock = vi.fn(); let root: Root; let container: HTMLDivElement;
const plans = [{ id:"p1",name:"Standard",entitlements:{max_prints_per_period:1000} },{id:"p2",name:"Business",entitlements:{max_prints_per_period:5000}}];
async function mount(props: Record<string,unknown> = {},locale:"ar"|"en"="en") {
  document.cookie=`yaseir_locale=${locale}; path=/`;
  await act(async () => root.render(h(I18nProvider,{initialLocale:locale,children:h(BillingActions,{plans,isOwner:true,status:"active",currentPlanId:"p1",...props})})));
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); }); }
beforeEach(() => { localStorage.clear(); document.cookie="yaseir_locale=en; path=/"; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true); vi.stubGlobal("fetch",fetchMock); fetchMock.mockReset(); refresh.mockReset(); container=document.createElement("div"); document.body.append(container); root=createRoot(container); });
afterEach(async () => { await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals(); });
describe("manual subscription request controls",()=>{
  it("preserves the explicitly selected plan for an active customer",async()=>{
    await mount({selectedPlanId:"p2",currentTerm:"yearly"});
    expect((container.querySelector("#request-plan") as HTMLSelectElement).value).toBe("p2");
    expect((container.querySelector("#request-term") as HTMLSelectElement).value).toBe("yearly");
    expect(container.textContent).toContain("reviewed before anything changes");
    expect(container.textContent).not.toMatch(/Stripe|checkout|Resume subscription/);
  });
  it("posts only an authenticated request and reconciles its safe reference",async()=>{
    fetchMock.mockResolvedValue(new Response(JSON.stringify({request:{id:"req_123",reference:"req_123",status:"pending",planId:"p2",term:"monthly",createdAt:"2030-01-01T00:00:00Z",whatsappUrl:"https://wa.me/966500000000?text=req_123"}}),{status:201}));
    await mount({selectedPlanId:"p2"});await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url,init]=fetchMock.mock.calls[0];expect(url).toBe("/api/subscription-requests");
    expect(JSON.parse(init.body)).toEqual({planId:"p2",term:"monthly"});
    expect(init.credentials).toBe("include");expect(init.headers["Idempotency-Key"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(container.textContent).toContain("req_123");expect(container.querySelector("form")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("reuses the same idempotency key after an ambiguous network failure",async()=>{
    fetchMock.mockRejectedValue(new Error("secret raw server exception"));await mount({selectedPlanId:"p2"});await submit();await submit();
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]);
    expect(container.textContent).not.toContain("secret raw");
  });
  it.each(["ar","en"] as const)("nonowners cannot submit or access a mutation control in %s",async locale=>{
    await mount({isOwner:false},locale);expect(container.querySelector("form")).toBeNull();expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(locale==="ar"?"مالك مساحة العمل":"Workspace Owner");
  });
  it("an existing pending request is shown instead of creating a second one",async()=>{
    const initialRequest:CustomerSubscriptionRequest={id:"req_old",reference:"req_old",status:"pending",planId:"p1",term:"yearly",createdAt:"2030-01-01T00:00:00Z"};
    await mount({initialRequest});expect(container.querySelector("form")).toBeNull();expect(container.textContent).toContain("req_old");expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["ar", "en"] as const)("archives an approved request in a collapsed history row while keeping a new request available in %s", async locale => {
    const initialRequest: CustomerSubscriptionRequest = {
      id: "req_approved", reference: "req_approved", status: "approved",
      planId: "p1", term: "monthly", createdAt: "2030-01-01T00:00:00Z",
    };
    // The old /billing?plan=p1 URL must not reopen the just-approved p1 request.
    await mount({initialRequest, selectedPlanId:"p1"}, locale);
    expect(container.querySelector("form")).toBeNull();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain(locale === "ar" ? "آخر طلب اشتراك" : "Latest subscription request");
    expect(details?.querySelector("summary")?.textContent).not.toContain(locale === "ar" ? "تمت الموافقة" : "approved");
    expect(details?.textContent).toContain("req_approved");
    const openLabel = locale === "ar" ? "تغيير الباقة أو التجديد" : "Change plan or renew";
    const open = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === openLabel);
    expect(open).toBeDefined();
    await act(async () => { open!.click(); });
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.querySelector("#request-plan")).not.toBeNull();
  });

  it("labels an approved custom term accurately instead of calling it monthly", async () => {
    const initialRequest: CustomerSubscriptionRequest = {
      id:"req_custom",reference:"req_custom",status:"approved",planId:"p1",term:"monthly",
      approvalModified:true,approvedPlanId:"p2",approvedTerm:"custom",approvedMonthlyQuota:5000,
      createdAt:"2030-01-01T00:00:00Z",
    };
    await mount({initialRequest});
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain("Custom duration");
    expect(details!.textContent).not.toContain("yearly term");
  });

  it("keeps customer request references LTR even inside Arabic pending content", async () => {
    const initialRequest: CustomerSubscriptionRequest = {
      id: "req_123ABC", reference: "req_123ABC", status: "pending",
      planId: "p2", term: "yearly", createdAt: "2030-01-01T00:00:00Z", requestedMonthlyQuota: 5000,
    };
    await mount({initialRequest}, "ar");
    expect(container.querySelector("form")).toBeNull();
    expect([...container.querySelectorAll('bdi[dir="ltr"]')].some(el => el.textContent === "req_123ABC")).toBe(true);
  });
});
