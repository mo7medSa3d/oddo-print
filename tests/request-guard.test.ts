import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

const { isCookieMutationSameOrigin } = await import("../src/server/request-guard");

function req(headers: Record<string, string>, method = "POST") {
  return { method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } as unknown as IncomingMessage;
}

describe("request guard cookie CSRF origin", () => {
  it("rejects a forged forwarded host that differs from the request host", () => {
    const old = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    try {
      expect(isCookieMutationSameOrigin(req({
        host: "127.0.0.1",
        "x-forwarded-host": "127.0.0.1:18080",
        origin: "http://127.0.0.1:18080",
        cookie: "cust_session=token",
        "sec-fetch-site": "same-origin",
      }))).toBe(false);
    } finally {
      if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old;
    }
  });

  it("rejects a cross-origin cookie mutation even when a forwarded host is present", () => {
    const old = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    try {
      expect(isCookieMutationSameOrigin(req({
        host: "127.0.0.1",
        "x-forwarded-host": "127.0.0.1:18080",
        origin: "http://attacker.invalid",
        cookie: "cust_session=token",
        "sec-fetch-site": "cross-site",
      }))).toBe(false);
    } finally {
      if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old;
    }
  });
});
