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

  it("checks HTTPS scheme and the configured public host, including behind TLS termination", () => {
    const savedBaseUrl = process.env.APP_BASE_URL;
    const savedFile = process.env.APP_BASE_URL_FILE;
    try {
      delete process.env.APP_BASE_URL_FILE;
      process.env.APP_BASE_URL = "https://app.example.com";
      const req = (source: Record<string, string>) => request({
        host: "app.example.com",
        cookie: "mgr_session=token",
        "sec-fetch-site": "same-site",
        ...source,
      });
      expect(isCookieMutationSameOrigin(req({ origin: "https://app.example.com" }))).toBe(true);
      expect(isCookieMutationSameOrigin(req({ origin: "http://app.example.com" }))).toBe(false);
      expect(isCookieMutationSameOrigin(req({ referer: "http://app.example.com/settings" }))).toBe(false);
      expect(isCookieMutationSameOrigin(req({ referer: "https://app.example.com/settings" }))).toBe(true);
      expect(isCookieMutationSameOrigin(req({ host: "different.example.com", origin: "https://app.example.com" }))).toBe(false);
    } finally {
      if (savedBaseUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = savedBaseUrl;
      if (savedFile === undefined) delete process.env.APP_BASE_URL_FILE;
      else process.env.APP_BASE_URL_FILE = savedFile;
    }
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
