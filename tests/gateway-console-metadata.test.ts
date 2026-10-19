import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_PAGINATION_HEADERS, GATEWAY_PAGINATION_HEADER_VALUE_MAX_BYTES,
  readGatewayPaginationHeaders,
} from "../src/desktop/lib/gateway-headers";

const from = (headers: Record<string, unknown>) => readGatewayPaginationHeaders((key) => headers[key]);

describe("Gateway console pagination metadata", () => {
  it("matches the shared producer/consumer byte contract", () => {
    const contract = JSON.parse(readFileSync("contracts/gateway-console-contract.json", "utf8"));
    expect([...GATEWAY_PAGINATION_HEADERS]).toEqual(contract.paginationHeaders);
    expect(GATEWAY_PAGINATION_HEADER_VALUE_MAX_BYTES).toBe(contract.paginationHeaderValueMaxBytes);
  });

  it("preserves every allowed cursor field and excludes credentials/private headers", () => {
    const headers = Object.fromEntries(GATEWAY_PAGINATION_HEADERS.map((key) => [key, "cursor%2Fid"]));
    expect(from({ ...headers, Authorization: "private", "set-cookie": "private", "content-type": "application/json" })).toEqual(headers);
  });

  it("retains exact-bound ASCII cursors without truncation", () => {
    const cursor = "a".repeat(4096);
    expect(from({ "x-next-cursor": cursor })).toEqual({ "x-next-cursor": cursor });
  });

  it("retains exact-bound UTF-8 cursors", () => {
    const cursor = "ع".repeat(2048);
    expect(from({ "x-next-before-id": cursor })).toEqual({ "x-next-before-id": cursor });
  });

  it("rejects oversized ASCII metadata instead of dropping continuation", () => {
    expect(() => from({ "x-has-more": "true", "x-next-cursor": "a".repeat(4097) })).toThrow("Invalid Gateway pagination metadata");
  });

  it("uses UTF-8 bytes rather than JavaScript code-unit count", () => {
    expect(() => from({ "x-next-before-id": "ع".repeat(2049) })).toThrow("Invalid Gateway pagination metadata");
  });

  it("rejects malformed native metadata without coercion", () => {
    expect(() => from({ "x-next-cursor": 123 })).toThrow("Invalid Gateway pagination metadata");
  });

  it("accepts an absent or empty optional metadata map", () => {
    expect(from({ "x-has-more": "", "x-next-cursor": null })).toEqual({});
  });
});
