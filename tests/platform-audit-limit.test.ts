import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseStrictListLimit } from "../src/lib/request-limits";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn() }));
vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.auth,
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
}));
vi.mock("../src/db/client", () => ({ queryWithTimeout: mocks.query }));

import { GET } from "../src/app/api/platform/audit/route";

describe("platform audit list limit contract", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.auth.mockResolvedValue(undefined);
    mocks.query.mockReset();
  });

  it("accepts only positive, safe, exact decimal limits", () => {
    expect(parseStrictListLimit(null, 100, 500)).toBe(100);
    expect(parseStrictListLimit("0012", 100, 500)).toBe(12);
    expect(parseStrictListLimit("500", 100, 500)).toBe(500);
    expect(parseStrictListLimit("600", 100, 500)).toBe(500);
    for (const invalid of ["", " ", "0", "-1", "3junk", "2.5", "1e2", "Infinity", "9007199254740992"]) {
      expect(parseStrictListLimit(invalid, 100, 500), invalid).toBeNull();
    }
  });

  it("does not cache authenticated audit metadata on clients or intermediaries", async () => {
    mocks.query.mockResolvedValue([{ id: "test-audit-event" }]);
    const response = await GET(new Request("http://gateway.test/api/platform/audit?limit=10"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ auditEvents: [{ id: "test-audit-event" }] });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each(["", " ", "0", "-1", "3junk", "2.5", "1e2", "9007199254740992"])(
    "returns INVALID_LIMIT for malformed %s without querying the audit log", async (value) => {
      const url = new URL("http://gateway.test/api/platform/audit");
      url.searchParams.set("limit", value);
      const response = await GET(new Request(url));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_LIMIT" });
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
});
