import { describe, expect, it } from "vitest";
import { normalizeGatewayUrl } from "../src/desktop/lib/ipc";

/**
 * The native Rust and Go gateways reject even an empty query/fragment marker.
 * The browser URL API exposes empty ?/# as search === "" / hash === "", so
 * renderer validation must inspect their presence, not only their value.
 */
describe("Desktop Gateway origin matches native Rust/Go URL boundary", () => {
  it.each([
    "https://gateway.example.com/?",
    "https://gateway.example.com?",
    "https://gateway.example.com/#",
    "https://gateway.example.com#",
    "https://gateway.example.com/?#",
    "http://localhost:3000/?",
    "http://localhost:3000/#",
  ])("rejects an empty query or fragment marker (%s)", (input) => {
    expect(() => normalizeGatewayUrl(input))
      .toThrow("Gateway URL cannot include query strings or fragments");
  });

  it.each([
    ["gateway.example.com", "https://gateway.example.com"],
    ["https://gateway.example.com/", "https://gateway.example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("continues accepting native-supported root origins (%s)", (raw, expected) => {
    expect(normalizeGatewayUrl(raw)).toBe(expected);
  });

  it.each([
    "https://@gateway.example.com/",
    "https://:@gateway.example.com/",
    "https://user:@gateway.example.com/",
  ])("rejects any raw userinfo marker, including empty credentials (%s)", (input) => {
    expect(() => normalizeGatewayUrl(input))
      .toThrow("Gateway URL cannot include embedded credentials");
  });

  it.each([
    "https://gateway.example.com:/",
    "https://gateway.example.com:0/",
    "https://gateway.example.com:00000/",
    "http://localhost:/",
    "http://localhost:0/",
    "https://[::1]:/",
    "https://[::1]:0/",
  ])("rejects an empty or zero network port without parser normalization (%s)", (input) => {
    expect(() => normalizeGatewayUrl(input))
      .toThrow("Gateway URL port must be between 1 and 65535");
  });

  it.each([
    ["https://gateway.example.com:443/", "https://gateway.example.com"],
    ["https://gateway.example.com:8443/", "https://gateway.example.com:8443"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("retains valid native-supported port configuration (%s)", (input, expected) => {
    expect(normalizeGatewayUrl(input)).toBe(expected);
  });

  it("accepts remote HTTP for staging and still rejects nonroot paths before pairing", () => {
    expect(normalizeGatewayUrl("http://gateway.example.com")).toBe("http://gateway.example.com");
    expect(() => normalizeGatewayUrl("https://gateway.example.com/base"))
      .toThrow("Gateway URL must use the origin root");
  });
});
