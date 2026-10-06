import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "http";
import { isCookieMutationSameOrigin } from "../src/server/request-guard";

function request(headers: Record<string, string>, method = "POST"): IncomingMessage {
  return {
    method,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
  } as unknown as IncomingMessage;
}

describe("cookie-authenticated mutation CSRF boundary", () => {
  it("allows same-origin browser mutations", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
      origin: "https://app.example.com",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("rejects cross-site browser mutations even when SameSite is relied upon by the browser", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }))).toBe(false);
  });

  it("rejects forged same-site origins that are not the target host", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
      origin: "https://evil.app.example.com",
      "sec-fetch-site": "same-site",
    }))).toBe(false);
  });

  it("uses Referer when Origin is absent", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
      referer: "https://app.example.com/billing",
    }))).toBe(true);
  });

  it("fails closed when ambient session cookies have neither origin signal", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
    }))).toBe(false);
  });

  it("does not block Authorization-header service traffic without ambient cookies", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      authorization: "Bearer agent-secret",
    }))).toBe(true);
  });

  it("treats GET as safe regardless of origin metadata", () => {
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_session=token",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }, "GET"))).toBe(true);
  });

  it("applies origin proof to refresh-only requests (expired access cookie)", () => {
    // After access expiry the browser sends mgr_refresh alone. That request
    // authenticates (refresh family) and mutates, so it must not bypass the
    // guard that access-cookie requests face.
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "mgr_refresh=token",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }))).toBe(false);
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "cust_refresh=token",
      origin: "https://app.example.com",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
    expect(isCookieMutationSameOrigin(request({
      host: "app.example.com",
      cookie: "plt_refresh=token",
    }))).toBe(false);
  });
});
