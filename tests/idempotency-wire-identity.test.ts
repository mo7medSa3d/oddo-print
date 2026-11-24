import { describe, expect, it } from "vitest";
import { isExactIdempotencyKey } from "../src/lib/idempotency";

describe("opaque idempotency identity on the wire", () => {
  it("accepts valid exact ASCII and Unicode operation keys", () => {
    expect(isExactIdempotencyKey("pos-2026-operation-001")).toBe(true);
    expect(isExactIdempotencyKey("طلب_طباعة_١")).toBe(true);
    expect(isExactIdempotencyKey("A".repeat(200))).toBe(true);
  });

  it("rejects whitespace and controls instead of silently selecting another operation", () => {
    for (const key of ["", " op", "op ", "\noperation", "op\u0085eration", "A".repeat(201)]) {
      expect(isExactIdempotencyKey(key)).toBe(false);
    }
  });

  it("rejects unpaired UTF-16 surrogates before UTF-8 encoding replaces them", () => {
    // JSON accepts these code units, but URL/UTF-8 transports do not preserve
    // their identity. The replacement glyph must never alias a stored receipt.
    for (const key of ["op-\uD800", "\uDC00-op", "op-\uD800-tail", "op-\uDC00-tail"]) {
      expect(isExactIdempotencyKey(key)).toBe(false);
    }
    expect(isExactIdempotencyKey("op-🖨")).toBe(true);
  });
});

describe("exact idempotency key validation preserves rejected string diagnostics", () => {
  it("does not narrow rejected string inputs to never", () => {
    function rejection(input: string) {
      if (!isExactIdempotencyKey(input)) return input.length > 200 ? "too long" : "invalid";
      return "valid";
    }
    expect(rejection("k".repeat(201))).toBe("too long");
    expect(rejection(" key ")).toBe("invalid");
    expect(rejection("a-long-enough-operation-key")).toBe("valid");
  });
});
