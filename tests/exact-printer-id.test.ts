import { describe, expect, it } from "vitest";
import { isExactPrinterId } from "../src/lib/exact-printer-id";

describe("opaque printer identity wire contract", () => {
  it("preserves valid exact Unicode printer IDs without trimming or rewriting", () => {
    expect(isExactPrinterId("printer_net_abc")).toBe(true);
    expect(isExactPrinterId("طابعة_المطبخ")).toBe(true);
    expect(isExactPrinterId("printer room")).toBe(true);
    for (const invalid of ["", "  ", " printer", "printer ", "printer\n", "printer\u0085"]) {
      expect(isExactPrinterId(invalid)).toBe(false);
    }
  });

  it("enforces 120 UTF-8 bytes, not just 120 UTF-16 code units", () => {
    expect(isExactPrinterId("é".repeat(60))).toBe(true);
    expect(isExactPrinterId("é".repeat(61))).toBe(false);
    expect(isExactPrinterId("🖨".repeat(30))).toBe(true);
    expect(isExactPrinterId("🖨".repeat(31))).toBe(false);
  });

  it("rejects unpaired UTF-16 surrogates before network encoding changes the identity", () => {
    expect(isExactPrinterId("\uD800")).toBe(false);
    expect(isExactPrinterId("printer\uDC00")).toBe(false);
  });
});

describe("exact printer ID validation preserves diagnostic strings", () => {
  it("keeps the original malformed string available for length-aware errors", () => {
    function rejection(input: string) {
      if (!isExactPrinterId(input)) return input.length > 120 ? "too long" : "invalid";
      return "valid";
    }
    expect(rejection("p".repeat(121))).toBe("too long");
    expect(rejection(" printer ")).toBe("invalid");
    expect(rejection("printer")).toBe("valid");
  });
});
