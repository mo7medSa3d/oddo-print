import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { friendlyDiagnosticAdmissionError } from "../src/desktop/lib/printers";
import { translate } from "../src/i18n/translate";

describe("desktop diagnostic admission error localization", () => {
  it("distinguishes quota exhaustion, temporary capacity and subscription holds in both locales", () => {
    const cases = [
      ["PRINT_QUOTA_EXCEEDED", 429, "errors.printQuotaExceeded"],
      ["TENANT_ENTITLEMENT_EXCEEDED", 429, "errors.printCapacityExceeded"],
      ["TENANT_SUBSCRIPTION_REQUIRED", 403, "errors.billingBlocked"],
      ["TENANT_ENTITLEMENT_UNAVAILABLE", 503, "errors.billingBlocked"],
      ["CAPABILITY_MISMATCH", 422, "errors.capabilityMismatch"],
      ["PRINTER_NOT_SHARED", 409, "printer.presentation.notSharedReason"],
    ] as const;
    for (const [code, status, key] of cases) {
      const error = Object.assign(new Error("PRIVATE ENGLISH GATEWAY DIAGNOSTIC"), {code, status});
      for (const locale of ["en", "ar"] as const) {
        const message = friendlyDiagnosticAdmissionError(error, locale);
        expect(message).toBe(translate(locale, key));
        expect(message).not.toContain("PRIVATE ENGLISH GATEWAY DIAGNOSTIC");
      }
    }
    expect(friendlyDiagnosticAdmissionError({code: "PRINT_QUOTA_EXCEEDED", status: 429}, "ar"))
      .not.toBe(friendlyDiagnosticAdmissionError({code: "TENANT_ENTITLEMENT_EXCEEDED", status: 429}, "ar"));
  });

  it("never turns unrecognized or transport-ambiguous outcomes into proof of a failed print", () => {
    for (const locale of ["en", "ar"] as const) {
      const uncertain = Object.assign(new Error("Socket reset after dispatch"), { status: 503 });
      expect(friendlyDiagnosticAdmissionError(uncertain, locale))
        .toBe(translate(locale, "diagnostic.admissionUnknown"));
      expect(friendlyDiagnosticAdmissionError({status: 429, code: "UNRECOGNIZED"}, locale))
        .toBe(translate(locale, "errors.tooManyAttempts"));
      expect(friendlyDiagnosticAdmissionError({status: 401, code: "PRINT_QUOTA_EXCEEDED"}, locale))
        .toBe(translate(locale, "diagnostic.authRequired"));
    }
  });

  it("keeps the retired customer Desktop test-print handler absent", () => {
    const source = readFileSync("src/desktop/main.tsx", "utf8");
    expect(source).not.toContain("friendlyDiagnosticAdmissionError(e, locale)");
    expect(source).not.toContain("diagnosticOps.current.uncertain(scope)");
    expect(source).not.toContain("testGatewayPrinter(");
  });
});
