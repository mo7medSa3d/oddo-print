import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Unauthenticated callers must receive 401 (login redirect / session refresh),
// never 403 (permission failure on a valid session). The desktop refresh and
// dashboard redirect contracts key only on 401.
const ROUTES = [
  "src/app/api/billing/cancel/route.ts",
  "src/app/api/billing/resume/route.ts",
  "src/app/api/billing/portal/route.ts",
  "src/app/api/billing/checkout/route.ts",
  "src/app/api/team/ownership/route.ts",
];

describe("unauthenticated callers receive 401, not 403", () => {
  for (const file of ROUTES) {
    it(`${file} splits missing identity (401) from forbidden (403)`, () => {
      const source = readFileSync(file, "utf8");
      // A bare `!claims?.userId` guard returning 401 must precede any
      // permission check that returns 403.
      const unauthenticated = source.indexOf("if (!claims?.userId)");
      expect(unauthenticated, `${file}: missing 401 guard for absent identity`).toBeGreaterThanOrEqual(0);
      expect(source.slice(unauthenticated, unauthenticated + 200)).toContain("401");
      // The old conflated shape must be gone.
      expect(source).not.toContain("if (!claims?.userId || !hasManagerPermission");
      expect(source).not.toContain("if (!claims?.userId || claims.role");
    });
  }
});
