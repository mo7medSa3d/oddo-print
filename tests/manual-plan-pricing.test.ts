import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseManualPlan } from "../src/lib/manual-plans";
import { formatPlanPrice, formatPlanPriceDisplay, parsePlanPriceAmount } from "../src/lib/plan-price";
import { v4AdminEn, v4AdminAr } from "../src/i18n/messages/v4-admin";
const base={id:"basic",name:"Basic",description:"",monthlyQuota:1000};
describe("manual price catalog",()=>{
 it("stores exact USD/SAR minor units",()=>{
  expect(parseManualPlan({...base,priceAmount:"19.95",priceCurrency:"USD"})).toMatchObject({priceMinorUnits:1995,priceCurrency:"USD"});
  expect(parseManualPlan({...base,priceAmount:"0",priceCurrency:"SAR"})).toMatchObject({priceMinorUnits:0,priceCurrency:"SAR"});
  expect(parseManualPlan({...base,priceAmount:"10.5",priceCurrency:"SAR"}).priceMinorUnits).toBe(1050);
 });
 it("does not assign a made-up price to old catalog entries",()=>{
  expect(parseManualPlan(base)).toMatchObject({priceMinorUnits:null,priceCurrency:null});
 });
 it.each(["-1","0.001","1e3","NaN","21474836.48"," 20 ","1,000","01",""])("rejects malformed money %s",value=>{
  expect(()=>parseManualPlan({...base,priceAmount:value,priceCurrency:"USD"})).toThrow("PLAN_INVALID");
 });
 it("rejects unsupported currencies and incomplete price pairs",()=>{
  expect(()=>parseManualPlan({...base,priceAmount:"20",priceCurrency:"EGP"})).toThrow("PLAN_INVALID");
  expect(()=>parseManualPlan({...base,priceAmount:"20"})).toThrow("PLAN_INVALID");
  expect(()=>parseManualPlan({...base,priceCurrency:"SAR"})).toThrow("PLAN_INVALID");
 });

 it("requires a numeric monthly quota instead of coercing booleans or string tokens",()=>{
  for(const invalid of ["1000","1e3","1000.0","",true,false,null,{},[], " 1000 "]) {
   expect(()=>parseManualPlan({...base,monthlyQuota:invalid})).toThrow("PLAN_INVALID");
  }
  expect(parseManualPlan({...base,monthlyQuota:1000}).entitlements.max_prints_per_period).toBe(1000);
 });
 it("requires a numeric optional display order, without Number() coercion",()=>{
  for(const invalid of ["5","5e0","5.0","",true,false,null,{},[]]) {
   expect(()=>parseManualPlan({...base,displayOrder:invalid})).toThrow("PLAN_INVALID");
  }
  expect(parseManualPlan({...base,displayOrder:0}).displayOrder).toBe(0);
  expect(parseManualPlan(base).displayOrder).toBe(0);
 });

 it("keeps the Platform Owner plan form limits aligned with the parser",()=>{
  const source=readFileSync("src/app/platform/plans/page.tsx","utf8");
  // WP-G: same limits, reformatted by WP-B+C+F plans-page reformat (spaces/double quotes only).
  expect(source).toContain('maxLength={k === "description" ? 500 : k === "id" ? 64 : 120}');
  // WP-G: same pattern, reformatted by WP-B+C+F plans-page reformat.
  expect(source).toContain('pattern={k === "id" ? "[a-z0-9][a-z0-9_-]{1,63}" : undefined}');
  // WP-G: same limits, reformatted by WP-B+C+F plans-page reformat.
  expect(source).toContain('max={k === "monthlyQuota" ? 2147483647 : k === "maxAgents" ? 1000 : k === "maxPrinters" ? 10000 : k === "displayOrder" ? 1000000 : undefined}');
  expect(source).toContain('pattern="(?:0|[1-9][0-9]{0,9})(?:[.][0-9]{1,2})?"');
  expect(source).toContain("maxLength={13}");
 });
 it("shares the exact highest allowed catalog price between API and plan editor",()=>{
  expect(parsePlanPriceAmount("0")).toBe(0);
  expect(parsePlanPriceAmount("19.95")).toBe(1995);
  expect(parsePlanPriceAmount("21474836.47")).toBe(2147483647);
  for(const value of ["21474836.48","99999999.99","1e3","1.000","01"," 12.00 ", ""]) {
   expect(parsePlanPriceAmount(value)).toBeNull();
  }
  expect(parseManualPlan({...base,priceAmount:"21474836.47",priceCurrency:"SAR"}).priceMinorUnits).toBe(2147483647);
  expect(()=>parseManualPlan({...base,priceAmount:"21474836.48",priceCurrency:"SAR"})).toThrow("PLAN_INVALID");
  const form=readFileSync("src/app/platform/plans/page.tsx","utf8");
  expect(form).toContain("parsePlanPriceAmount(form.priceAmount)");
  // WP-G: call-site unification — same catalogue key, now via t() instead of a().
  expect(form).toContain('t("v4.admin.priceInvalid")');
  expect(v4AdminEn["v4.admin.priceInvalid"]).toBeTruthy();
  expect(v4AdminAr["v4.admin.priceInvalid"]).toMatch(/\p{Script=Arabic}/u);
 });
 it("formats only configured currency and amount",()=>{
  expect(formatPlanPrice(1995,"USD","en")).toContain("19.95");
  expect(formatPlanPrice(1995,"SAR","ar")).toContain("19.95");
  expect(formatPlanPrice(null,null,"en")).toBeNull();
  expect(formatPlanPrice(-1,"USD","en")).toBeNull();
  expect(formatPlanPrice(0,"USD","en")).toContain("0.00");
 });
 it("keeps amount and ISO currency in separate, locale-aware display tiers",()=>{
  expect(formatPlanPriceDisplay(1995,"USD","en")).toEqual({amount:"19.95",currency:"USD"});
  expect(formatPlanPriceDisplay(0,"USD","en")).toEqual({amount:"0.00",currency:"USD"});
  expect(formatPlanPriceDisplay(1995,"SAR","ar")?.currency).toBe("SAR");
  expect(formatPlanPriceDisplay(1995,"SAR","ar")?.amount).toContain("19");
  expect(formatPlanPriceDisplay(null,"USD","en")).toBeNull();
  expect(formatPlanPriceDisplay(-1,"SAR","ar")).toBeNull();
  expect(formatPlanPriceDisplay(100,"EUR","en")).toBeNull();
 });

});
