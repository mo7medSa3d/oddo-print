import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/app/onboarding/page.tsx", "utf8");

test("onboarding mount uses the same reconciliation loader exactly once", () => {
  const effectStart = source.indexOf("useEffect(() => {");
  const effectEnd = source.indexOf("async function submit", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "onboarding mount effect missing");
  const effect = source.slice(effectStart, effectEnd);
  assert.match(effect, /const controller = new AbortController\(\)/);
  assert.match(effect, /void loadPlans\(controller\.signal\)/);
  assert.match(effect, /return \(\) => controller\.abort\(\)/);
  assert.doesNotMatch(effect, /void fetchPlans\(/, "mount must not bypass the reconciliation loader");
});

test("reconciliation hydrates persisted workspace and subscription state", () => {
  const loadStart = source.indexOf("const loadPlans = useCallback");
  const effectStart = source.indexOf("useEffect(() => {", loadStart);
  assert.ok(loadStart >= 0 && effectStart > loadStart, "loadPlans block missing");
  const loader = source.slice(loadStart, effectStart);
  assert.match(loader, /fetchPlans\(signal\)/);
  assert.match(loader, /fetchWithTimeout\("\/api\/onboarding"/);
  assert.match(loader, /setName\(\(current\) => current \|\| tenantName\)/);
  assert.match(loader, /subscription\?\.planId/);
  assert.match(loader, /setWorkspaceProvisioned\(provisioned\)/);
});

test("all onboarding mount requests share the caller abort signal", () => {
  const fetchStart = source.indexOf("const fetchPlans = useCallback");
  const submitStart = source.indexOf("async function submit", fetchStart);
  const loaders = source.slice(fetchStart, submitStart);
  assert.match(loaders, /fetchWithTimeout\("\/api\/billing\/plans",[\s\S]*?signal,/);
  assert.match(loaders, /fetchWithTimeout\("\/api\/onboarding",[\s\S]*?signal,/);
  assert.match(loaders, /if \(signal\?\.aborted\) return;/);
});
