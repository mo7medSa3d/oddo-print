// @vitest-environment jsdom
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { translate } from "../src/i18n/translate";
const fixture=vi.hoisted(()=>({authenticated:false,role:"owner",status:"active",blocked:false,locale:"en" as "en"|"ar",priceMinorUnits:14900 as number|null,priceCurrency:"SAR" as "USD"|"SAR"|null,query:""}));
vi.mock("next/navigation",()=>({redirect:(url:string)=>{throw new Error("REDIRECT:"+url);}}));
vi.mock("next/headers",()=>({cookies:async()=>({get:(name:string)=>({value:name==="yaseir_locale"?fixture.locale:"session"})})}));
vi.mock("next/link",()=>({default:({children,...props}:Record<string,unknown>)=>h("a",props,children as ReactNode)}));
vi.mock("../src/lib/manager-auth",()=>({getManagerCookieName:()=>"mgr_session",verifyWorkspaceTokenFromCookieValues:async()=>fixture.authenticated?{role:fixture.role,tenantId:"tenant"}:null}));
vi.mock("../src/lib/database-clock",()=>({databaseNowMs:async()=>Date.parse("2030-05-15T00:00:00Z")}));
vi.mock("../src/db", () => {
  const query = {
    tenantSubscriptions: { findFirst: async () => ({planId:"manual-plan",status:fixture.status,currentPeriodStart:new Date("2030-01-01T00:00:00Z"),currentPeriodEnd:new Date("2031-01-01T00:00:00Z"),entitlementBlocked:fixture.blocked}) },
    tenants: { findFirst: async () => ({lifecycle:"active"}) },
  };
  return { db: {
    query,
    transaction: async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query }),
    select: () => ({from: () => ({where: (querySql: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      fixture.query = new PgDialect().sqlToQuery(querySql).sql;
      return {orderBy: async () => [{id:"manual-plan",name:"Manual public plan",description:null,priceMinorUnits:fixture.priceMinorUnits,priceCurrency:fixture.priceCurrency,entitlements:{max_prints_per_period:1000,max_agents:1,max_printers:1,max_concurrent_jobs:10,max_jobs_per_minute:10}}]};
    }})}),
  } };
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
import Pricing from "../src/app/pricing/page";
beforeEach(()=>{localStorage.clear();fixture.authenticated=false;fixture.role="owner";fixture.status="active";fixture.blocked=false;fixture.locale="en";fixture.priceMinorUnits=14900;fixture.priceCurrency="SAR";document.cookie="yaseir_locale=en; path=/";fixture.query="";});
async function render(){return renderToStaticMarkup(h(I18nProvider,{initialLocale:fixture.locale,children:await Pricing()}));}
describe("public manual plan catalog",()=>{
 it("includes active public plans without a provider price identifier",async()=>{const markup=await render();expect(markup).toContain("Manual public plan");expect(fixture.query).toContain("is_active");expect(fixture.query).toContain("is_public");expect(fixture.query).not.toContain("stripe");expect(markup).toContain('/signup?plan=manual-plan');});
 it("routes an active workspace owner to the existing subscription instead of showing choices",async()=>{fixture.authenticated=true;await expect(render()).rejects.toThrow("REDIRECT:/billing");});
 it("sends active non-owner members to their workspace",async()=>{fixture.authenticated=true;fixture.role="admin";await expect(render()).rejects.toThrow("REDIRECT:/dashboard");});
 it.each(["expired","suspended"])("never marks a %s subscription current",async status=>{fixture.authenticated=true;fixture.status=status;const markup=await render();expect(markup).toContain("Manual public plan");});
 it("renders configured SAR price without checkout",async()=>{const markup=await render();expect(markup).toContain("SAR");expect(markup).toContain("149");expect(markup).not.toContain("/api/billing/checkout");});

 it("uses one restrained pricing hierarchy and compact, matching navigation actions",async()=>{
  const markup=await render();
  expect(markup).toContain(translate("en","v4.pricing.publishedPrice"));
  expect(markup).toContain("149.00");
  expect(markup).toContain(">SAR</span>");
  expect(markup).not.toContain("$US");
  expect(markup).toContain('data-appearance="outline"');
  // v10-exact: pricing header CTAs moved from compact sm (40px) to the
  // guide standard md (44px, min-h-11) with 24px horizontal padding.
  expect(markup).toMatch(/href="\/login"[^>]*min-h-11/);
  expect(markup).toMatch(/href="\/signup"[^>]*min-h-11/);
  expect(markup).toContain('grid-cols-[1fr_auto]');
  expect(markup).toContain('text-ink-2');
 });
 it("shows a short truthful price-on-request label for unpriced plans",async()=>{
  fixture.priceMinorUnits=null;fixture.priceCurrency=null;
  const markup=await render();
  expect(markup).toContain(translate("en","v4.pricing.priceOnRequest"));
  expect(markup).not.toContain("149.00");
  fixture.locale="ar";document.cookie="yaseir_locale=ar; path=/";
  const arabic=await render();
  expect(arabic).toContain(translate("ar","v4.pricing.priceOnRequest"));
 });
 it("uses concise Arabic SaaS copy without unsupported retry-credit promises or duplicate footer sections",async()=>{
  fixture.locale="ar";document.cookie="yaseir_locale=ar; path=/";
  const markup=await render();
  expect(markup).toContain(translate("ar","v4.pricing.title"));
  expect(markup).toContain(translate("ar","v4.pricing.jobsPerMonth"));
  expect(markup).not.toContain(translate("ar","v4.pricing.unlimitedDevices"));
  expect(markup).not.toContain(translate("ar","v4.onboarding.monthlyReset"));
  expect(markup).not.toContain("إعادة إرسال المهمة نفسها بطريقة آمنة");
  expect(markup).not.toMatch(/max_agents|max_printers|max_jobs_per_minute|max_concurrent_jobs|Stripe|v4\.pricing\./);
 });
 it.each(["ar","en"] as const)("shows only grounded printing features inside the %s plan card",async locale=>{
  fixture.locale=locale;document.cookie=`yaseir_locale=${locale}; path=/`;
  const markup=await render();
  for(const key of ["v4.pricing.featureOdoo","v4.pricing.featurePos","v4.pricing.featureBranches","v4.pricing.featureActivity"] as const){
    expect(markup).toContain(translate(locale,key));
  }
  expect(markup).toContain('dir="ltr"');
  expect(markup).not.toContain(translate(locale,"v4.pricing.intro"));
  expect(markup).not.toMatch(/24\/7|guaranteed uptime|unlimited jobs|Stripe/);
 });
 it("renders one console action for an inactive, signed-in customer and keeps plan requests owner-only",async()=>{
  fixture.authenticated=true;fixture.status="expired";const markup=await render();
  expect(markup.match(/>Open console<\/a>/g)?.length).toBe(1);
  expect(markup).toContain('href="/billing?plan=manual-plan"');
 });
});
