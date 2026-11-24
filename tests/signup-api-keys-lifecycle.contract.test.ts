import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("signup and API-key loading lifecycle", () => {
  it("asks for the password only after email proof and stores no visitor password at signup", () => {
    const signup = read("src/app/signup/page.tsx");
    const registration = read("src/app/api/auth/register/route.ts");
    expect(signup).not.toContain('htmlFor="password"');
    expect(signup).not.toContain('password,');
    expect(registration).not.toContain('const password = typeof body.password');
    expect(registration).toContain("hashPassword(generateOpaqueToken())");
    expect(registration).toContain('NextResponse.json(GENERIC, { status: 202 })');
  });

  it("mints a session from an issued setup proof only, not from a recovery URL flag", () => {
    const verify = read("src/app/api/auth/verify-email/route.ts");
    const reset = read("src/app/api/auth/reset-password/route.ts");
    const ui = read("src/app/reset-password/page.tsx");
    expect(verify).toContain('id: `psu_${nanoid(18)}`');
    expect(reset).toContain('row.id.startsWith("psu_")');
    expect(reset).toContain("issueCustomerSession(");
    expect(reset).toContain("credentialVersionFor(row.userId, nextHash)");
    expect(ui).toContain("data.authenticated === true ? continuation : signInDestination");
  });

  it("gates protected initial paint and displays API credentials outside advanced settings", () => {
    const shell = read("src/components/AppShell.tsx");
    const page = read("src/app/api-keys/page.tsx");
    expect(shell).toContain('aria-busy="true"><PageSkeleton />');
    expect(page).toContain('"/api/billing/status"');
    expect(page).not.toContain('"/api/subscription-requests"');
    expect(page).not.toContain('v4.connection.advanced');
    expect(page).toContain("if (loading || !initialLoaded)");
    expect(page).toContain("Promise.all([");
    expect(page).toContain("setInitialLoaded(true)");
  });
});
