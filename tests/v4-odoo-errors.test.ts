import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error Odoo JS is exercised through the existing @web test adapter.
import { gatewayServerMessage, parseGatewayBillingLimit, showGatewayBillingLimitDialog } from "../odoo_addons19/print_gateway/static/src/js/gateway_limit_dialog";

describe("V4 Odoo customer error boundary", () => {
  it("never displays raw remote exception text, SQL, or credential material", () => {
    const value = gatewayServerMessage({ data: { message: "SQL error password=VERY_PRIVATE_SECRET" } });
    expect(value).toBeTruthy();
    expect(value).not.toMatch(/SQL|password|VERY_PRIVATE_SECRET/);
  });
  it("translates a stable printer code into actionable customer guidance", () => {
    expect(gatewayServerMessage({ data: { message: "PRINTER_OFFLINE: raw Windows error 0x0000709" } })).toBe(
      "The selected printer is unavailable. Check its computer, power and connection before trying again.",
    );
  });
  it("preserves uncertainty instead of promising no physical output", () => {
    const value = gatewayServerMessage({ message: "UNKNOWN_SUBMISSION_OUTCOME: disconnected" });
    expect(value).toContain("Check the printer");
    expect(value).not.toContain("Nothing was printed");
  });
  it("explains that an explicitly rejected POS receipt must be deliberately reprinted", () => {
    const details = parseGatewayBillingLimit('GATEWAY_BILLING_LIMIT:{"entitlement":"max_prints_per_period","limit":100,"used":100,"manualReprintRequired":true,"message":"PRIVATE"}');
    expect(details?.manualReprintRequired).toBe(true);
    let dialog: { body: string } | undefined;
    showGatewayBillingLimitDialog({ services: { dialog: { add(_type: unknown, options: { body: string }) { dialog = options; } } } }, details);
    expect(dialog?.body).toContain("reprint it explicitly only if still needed");
    expect(dialog?.body).not.toContain("PRIVATE");
  });

  it("validates direct RPC billing details before showing any dialog", () => {
    const dialogs: { body: string }[] = [];
    const env = { services: { dialog: { add(_type: unknown, options: { body: string }) { dialogs.push(options); } } } };
    // A direct RPC object does not pass through parseGatewayBillingLimit.
    // Inherited Object.prototype keys must never be accepted as entitlements.
    expect(showGatewayBillingLimitDialog(env, { entitlement: "__proto__", message: "forged", used: 5, limit: 5 })).toBe(false);
    expect(dialogs).toHaveLength(0);
    // A partial but valid signal must still show actionable local copy, rather
    // than throwing when a counter is absent (or echoing a backend message).
    expect(showGatewayBillingLimitDialog(env, { entitlement: "max_prints_per_period", message: "INTERNAL_BILLING_SECRET" })).toBe(true);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].body).toContain("monthly");
    expect(dialogs[0].body).not.toContain("INTERNAL_BILLING_SECRET");
    expect(dialogs[0].body).not.toContain("Used:");
    expect(dialogs[0].body).not.toContain("Allowance:");
  });

  it("uses local quota wording and ignores backend English in structured limit details", () => {
    const details = parseGatewayBillingLimit('GATEWAY_BILLING_LIMIT:{"entitlement":"max_prints_per_period","limit":100,"used":100,"message":"INTERNAL_BACKEND_SECRET"}');
    expect(details.message).not.toContain("INTERNAL_BACKEND_SECRET");
    let dialog: { body: string } | undefined;
    showGatewayBillingLimitDialog({ services: { dialog: { add(_type: unknown, options: { body: string }) { dialog = options; } } } }, details);
    expect(dialog?.body).toContain("monthly");
    expect(dialog?.body).not.toContain("next month");
    expect(dialog?.body).not.toContain("INTERNAL_BACKEND_SECRET");
  });
  it("trusts the definite Gateway rejection code over unrelated traceback markers", () => {
    const quota = gatewayServerMessage({
      message: "Odoo Server Error",
      data: { code: "PRINT_QUOTA_EXCEEDED", message: "UNKNOWN_SUBMISSION_OUTCOME in a previous attempt's traceback" },
    });
    expect(quota).toContain("monthly allowance");
    expect(quota).not.toContain("Check the printer");

    const unknown = gatewayServerMessage({
      message: "Odoo Server Error",
      data: { code: "UNKNOWN_SUBMISSION_OUTCOME", message: "PRINT_QUOTA_EXCEEDED from an unrelated log line" },
    });
    expect(unknown).toContain("Check the printer");
    expect(unknown).not.toContain("monthly allowance");
  });


  it("keeps Odoo POS receipt and kitchen notices behind the safe localized error presenter", () => {
    const source = readFileSync("odoo_addons19/print_gateway/static/src/js/pos_print_router.js", "utf8");
    const receiptNotices = source.slice(
      source.indexOf('// Truthful feedback: "submitted"'),
      source.indexOf("// Count only accepted/known print outcomes"),
    );
    expect(receiptNotices).toContain('gatewayServerMessage({');
    expect(receiptNotices).toContain('code: result?.code, message: result?.message');
    expect(receiptNotices).not.toContain("result?.outputMedium === \"file\" ? result.message");
    expect(receiptNotices).not.toMatch(/result\?\.message\s*\|\|\s*_t/);
    expect(source).toContain("EXPLICITLY_UNKNOWN_CODES.has(result?.code)");
    expect(source).toContain("result?.can_retry !== true || explicitlyUnknownCode");
    const kitchenResult = source.slice(source.indexOf("async printOrderChanges("));
    expect(kitchenResult).toContain('body: gatewayServerMessage({ data: { code: result?.code, message: result?.message } })');
    expect(kitchenResult).not.toContain('body: result?.message || _t("Kitchen / Preparation printing failed.")');
    // Machine code takes precedence even over deceptive unknown-submission prose.
    expect(gatewayServerMessage({
      data: { code: "PRINTER_OFFLINE", message: "SQL password=DO_NOT_SHOW" },
    })).toContain("printer is unavailable");
  });

  it("keeps technical print-capacity failures distinct from quota and subscription holds", () => {
    const failures = [
      ["max_jobs_per_minute", "Too many prints at once"],
      ["max_concurrent_jobs", "Too many jobs printing now"],
      ["max_agents", "technical capacity"],
      ["max_printers", "technical capacity"],
    ];
    for (const [entitlement, expected] of failures) {
      const message = gatewayServerMessage({
        data: {
          code: "TENANT_ENTITLEMENT_EXCEEDED",
          entitlement,
          message: "UNKNOWN_SUBMISSION_OUTCOME from unrelated SQL password=PRIVATE_SECRET",
        },
      });
      expect(message).toContain(expected);
      expect(message).not.toContain("monthly allowance");
      expect(message).not.toContain("PRIVATE_SECRET");
      expect(message).not.toContain("Check the printer");
    }
    const unknownCapacity = gatewayServerMessage({ data: { code: "TENANT_ENTITLEMENT_EXCEEDED", entitlement: "__proto__", message: "remote secret" } });
    expect(unknownCapacity).toContain("technical capacity");
    const blocked = gatewayServerMessage({ data: { code: "TENANT_ENTITLEMENT_UNAVAILABLE", message: "remote secret" } });
    expect(blocked).toContain("not active");
    expect(blocked).not.toContain("remote secret");
    expect(blocked).not.toContain("monthly allowance");
  });


  it("does not misclassify explicitly uncertain submissions as definite quota refusal", () => {
    const marker = 'GATEWAY_BILLING_LIMIT:{"code":"PRINT_QUOTA_EXCEEDED","entitlement":"max_prints_per_period","limit":5,"used":5}';
    expect(parseGatewayBillingLimit({ data: { code: "UNKNOWN_SUBMISSION_OUTCOME", message: marker } })).toBeNull();
    const invalid = 'GATEWAY_BILLING_LIMIT:{"code":"UNKNOWN_SUBMISSION_OUTCOME","entitlement":"max_prints_per_period","limit":5,"used":5}';
    expect(parseGatewayBillingLimit(invalid)).toBeNull();
    const wrongEntitlement = 'GATEWAY_BILLING_LIMIT:{"code":"PRINT_QUOTA_EXCEEDED","entitlement":"max_concurrent_jobs","limit":5,"used":5}';
    expect(parseGatewayBillingLimit(wrongEntitlement)).toBeNull();
    let opened = 0;
    const env = { services: { dialog: { add() { opened += 1; } } } };
    expect(showGatewayBillingLimitDialog(env, { code: "UNKNOWN_SUBMISSION_OUTCOME", entitlement: "max_prints_per_period", message: "PRIVATE" })).toBe(false);
    expect(opened).toBe(0);
    expect(parseGatewayBillingLimit(marker)).toMatchObject({ code: "PRINT_QUOTA_EXCEEDED", entitlement: "max_prints_per_period" });
  });

  it("parses a bounded structured quota marker before a trailing RPC traceback", () => {
    const marker = JSON.stringify({
      code: "PRINT_QUOTA_EXCEEDED", entitlement: "max_prints_per_period",
      limit: 20, used: 20, manualReprintRequired: true,
      message: "PRIVATE_BACKEND_SECRET {quoted object text}",
    });
    const error = { message: "Odoo Server Error", data: {
      message: `ValidationError: GATEWAY_BILLING_LIMIT:   ${marker}\nRPC traceback: UNKNOWN_OLD_OPERATION`,
    } };
    const details = parseGatewayBillingLimit(error);
    expect(details).toMatchObject({
      code: "PRINT_QUOTA_EXCEEDED", entitlement: "max_prints_per_period",
      used: 20, limit: 20, manualReprintRequired: true,
    });
    expect(details?.message).not.toContain("PRIVATE_BACKEND_SECRET");
    expect(details?.message).not.toContain("UNKNOWN_OLD_OPERATION");
  });

});
