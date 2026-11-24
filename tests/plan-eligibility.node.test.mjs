import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadEvaluatePlanChangeEligibility() {
  const src = fs.readFileSync("src/lib/plan-price.ts", "utf8");
  const start = src.indexOf("export function evaluatePlanChangeEligibility");
  assert.ok(start >= 0, "evaluatePlanChangeEligibility not found in src/lib/plan-price.ts");
  let fnSrc = src.slice(start);
  // Strip TypeScript types cleanly for direct Node 18 execution
  fnSrc = fnSrc
    .replace(/^export function evaluatePlanChangeEligibility\([\s\S]*?\): PlanEligibility \{/, "function evaluatePlanChangeEligibility(input) {");
  return vm.runInThisContext(`(${fnSrc})`);
}

const evaluatePlanChangeEligibility = loadEvaluatePlanChangeEligibility();

test("Active monthly subscriber cannot re-subscribe to same plan monthly", () => {
  const res = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "monthly",
    targetPlanId: "business",
    targetTerm: "monthly",
  });
  assert.equal(res.allowed, false);
  assert.equal(res.action, "blocked");
  assert.equal(res.reason, "already_active");
  assert.equal(res.isCurrentPlan, true);
});

test("Active monthly subscriber CAN upgrade same plan to yearly", () => {
  const res = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "monthly",
    targetPlanId: "business",
    targetTerm: "yearly",
  });
  assert.equal(res.allowed, true);
  assert.equal(res.action, "upgrade_to_yearly");
  assert.equal(res.reason, "ok");
  assert.equal(res.isCurrentPlan, true);
});

test("Active yearly subscriber cannot re-subscribe to same plan yearly", () => {
  const res = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "yearly",
    targetPlanId: "business",
    targetTerm: "yearly",
  });
  assert.equal(res.allowed, false);
  assert.equal(res.action, "blocked");
  assert.equal(res.reason, "already_active");
  assert.equal(res.isCurrentPlan, true);
});

test("Active yearly subscriber CANNOT downgrade same plan to monthly", () => {
  const res = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "yearly",
    targetPlanId: "business",
    targetTerm: "monthly",
  });
  assert.equal(res.allowed, false);
  assert.equal(res.action, "blocked");
  assert.equal(res.reason, "already_on_yearly");
  assert.equal(res.isCurrentPlan, true);
});

test("Active subscriber CAN request any different plan (monthly or yearly)", () => {
  for (const targetTerm of ["monthly", "yearly"]) {
    const res = evaluatePlanChangeEligibility({
      status: "active",
      currentPlanId: "business",
      currentTerm: "yearly",
      targetPlanId: "enterprise",
      targetTerm,
    });
    assert.equal(res.allowed, true);
    assert.equal(res.action, "switch_plan");
    assert.equal(res.reason, "ok");
    assert.equal(res.isCurrentPlan, false);
  }
});

test("Expired or awaiting_activation workspace CAN subscribe to any plan including prior plan", () => {
  for (const status of ["expired", "awaiting_activation", "suspended"]) {
    const res = evaluatePlanChangeEligibility({
      status,
      currentPlanId: "business",
      currentTerm: "yearly",
      targetPlanId: "business",
      targetTerm: "monthly",
    });
    assert.equal(res.allowed, true);
    assert.equal(res.action, "subscribe");
    assert.equal(res.reason, "ok");
  }
});

test("Pending request blocks both the same plan+term and other cards cleanly", () => {
  const same = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "starter",
    currentTerm: "monthly",
    targetPlanId: "business",
    targetTerm: "yearly",
    pendingRequest: { planId: "business", term: "yearly" },
  });
  assert.equal(same.allowed, false);
  assert.equal(same.reason, "pending_same_request");

  const other = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "starter",
    currentTerm: "monthly",
    targetPlanId: "enterprise",
    targetTerm: "yearly",
    pendingRequest: { planId: "business", term: "yearly" },
  });
  assert.equal(other.allowed, false);
  assert.equal(other.reason, "pending_other_request");
});

test("Server route POST /api/subscription-requests enforces evaluatePlanChangeEligibility", () => {
  const routeSrc = fs.readFileSync("src/app/api/subscription-requests/route.ts", "utf8");
  assert.match(routeSrc, /evaluatePlanChangeEligibility/);
  assert.match(routeSrc, /SUBSCRIPTION_YEARLY_ACTIVE/);
  assert.match(routeSrc, /SUBSCRIPTION_ALREADY_ACTIVE/);
});

test("Active subscriber whose plan is expiringSoon CAN renew same plan+term, but yearly->monthly stays blocked", () => {
  const renewMonthly = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "monthly",
    targetPlanId: "business",
    targetTerm: "monthly",
    expiringSoon: true,
  });
  assert.equal(renewMonthly.allowed, true);
  assert.equal(renewMonthly.action, "renew");

  const renewYearly = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "yearly",
    targetPlanId: "business",
    targetTerm: "yearly",
    expiringSoon: true,
  });
  assert.equal(renewYearly.allowed, true);
  assert.equal(renewYearly.action, "renew");

  const blockedDowngrade = evaluatePlanChangeEligibility({
    status: "active",
    currentPlanId: "business",
    currentTerm: "yearly",
    targetPlanId: "business",
    targetTerm: "monthly",
    expiringSoon: true,
  });
  assert.equal(blockedDowngrade.allowed, false);
  assert.equal(blockedDowngrade.reason, "already_on_yearly");
});
