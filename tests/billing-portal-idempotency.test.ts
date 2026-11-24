import {describe,it,expect} from "vitest";
import { POST } from "../src/app/api/billing/portal/route";
import {readFileSync} from "node:fs";
describe("retired provider portal",()=>{
 it("never opens or replays an external payment session",async()=>{
  for(let i=0;i<2;i++)expect((await POST(new Request("https://example.test/api/billing/portal",{method:"POST"}))).status).toBe(410);
  const source=readFileSync("src/app/api/billing/portal/route.ts","utf8");expect(source).not.toContain("stripeRequest");expect(source).not.toContain("db.");
 });
});
