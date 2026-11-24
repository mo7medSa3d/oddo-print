import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { codeMessageKey, statusMessageKey, apiMessageKey } from "../src/lib/api-error-keys";
import { translate } from "../src/i18n/translate";
import { en } from "../src/i18n/messages/en";

/**
 * The Gateway API error contract.
 *
 * Routes return a stable, machine-readable `code` next to an English `error`
 * string that exists for logs. Clients map the code to a translated message
 * and never render the server string. Codes are therefore the contract; the
 * English text is not.
 */
describe("API error contract", () => {
  it("localizes combined page-size and offset errors from platform lists", () => {
    expect(codeMessageKey("INVALID_PAGINATION")).toBe("errors.invalidPagination");
    expect(apiMessageKey("INVALID_PAGINATION", 400)).toBe("errors.invalidPagination");
    for (const locale of ["en", "ar"] as const) {
      const combined = translate(locale, "errors.invalidPagination");
      expect(combined).not.toBe(translate(locale, "errors.requestRejected"));
      expect(combined).not.toBe(translate(locale, "errors.invalidPaginationLimit"));
      expect(combined).not.toContain("INVALID_PAGINATION");
    }
    expect(translate("en", "errors.invalidPagination")).toMatch(/page size or position/i);
    expect(translate("ar", "errors.invalidPagination")).toMatch(/[\u0600-\u06FF]/u);
  });

  it("maps strict job-history pagination failures to Arabic/English catalog copy", () => {
    expect(codeMessageKey("INVALID_OFFSET")).toBe("errors.invalidPaginationOffset");
    expect(apiMessageKey("INVALID_OFFSET", 400)).toBe("errors.invalidPaginationOffset");
    expect(translate("en", "errors.invalidPaginationOffset")).not.toBe("errors.requestRejected");
    expect(translate("ar", "errors.invalidPaginationOffset")).toMatch(/\p{Script=Arabic}/u);
  });

  it("translates malformed pagination limits rather than calling them offset errors", () => {
    const platformAudit = fs.readFileSync("src/app/api/platform/audit/route.ts", "utf8");
    expect(platformAudit).toContain('code: "INVALID_LIMIT"');
    expect(codeMessageKey("INVALID_LIMIT")).toBe("errors.invalidPaginationLimit");
    expect(apiMessageKey("INVALID_LIMIT", 400)).toBe("errors.invalidPaginationLimit");
    expect(translate("en", "errors.invalidPaginationLimit")).toMatch(/page size|limit/i);
    expect(translate("ar", "errors.invalidPaginationLimit")).toMatch(/\p{Script=Arabic}/u);
    expect(translate("en", "errors.invalidPaginationLimit")).not.toBe(translate("en", "errors.invalidPaginationOffset"));
  });

  it("explains Agent and printer safety limits without claiming too many login attempts", () => {
    expect(apiMessageKey("MAX_AGENTS_EXCEEDED", 429)).toBe("limit.title.agents");
    expect(apiMessageKey("MAX_PRINTERS_EXCEEDED", 429)).toBe("limit.title.printers");
    for (const locale of ["en", "ar"] as const) {
      for (const code of ["MAX_AGENTS_EXCEEDED", "MAX_PRINTERS_EXCEEDED"]) {
        const key = codeMessageKey(code);
        expect(key).toBeTruthy();
        const localized = translate(locale, key!);
        expect(localized).not.toBe(translate(locale, "errors.tooManyAttempts"));
        expect(localized).not.toBe(translate(locale, "errors.printQuotaExceeded"));
      }
    }
    expect(translate("en", "limit.title.agents")).toMatch(/agent limit/i);
    expect(translate("ar", "limit.title.printers")).toMatch(/[\u0600-\u06FF]/u);
  });

  it("distinguishes retryable print-rate or concurrency limits from subscription denial", () => {
    expect(apiMessageKey("TENANT_ENTITLEMENT_EXCEEDED", 429)).toBe("errors.printCapacityExceeded");
    for (const locale of ["en", "ar"] as const) {
      expect(translate(locale, "errors.printCapacityExceeded")).not.toBe(translate(locale, "errors.billingBlocked"));
      expect(translate(locale, "errors.printCapacityExceeded")).not.toBe(translate(locale, "errors.printQuotaExceeded"));
    }
    expect(translate("en", "errors.printCapacityExceeded")).toMatch(/capacity/i);
    expect(translate("ar", "errors.printCapacityExceeded")).toMatch(/[\u0600-\u06FF]/u);
  });

  it("localizes exhausted monthly print credits separately from blocked billing", () => {
    expect(codeMessageKey("PRINT_QUOTA_EXCEEDED")).toBe("errors.printQuotaExceeded");
    expect(apiMessageKey("PRINT_QUOTA_EXCEEDED", 429)).toBe("errors.printQuotaExceeded");
    expect(codeMessageKey("TENANT_ENTITLEMENT_UNAVAILABLE")).toBe("errors.billingBlocked");
    for (const locale of ["en", "ar"] as const) {
      const quota = translate(locale, "errors.printQuotaExceeded");
      expect(quota).not.toBe(translate(locale, "errors.billingBlocked"));
      expect(quota).not.toContain("PRINT_QUOTA_EXCEEDED");
    }
    expect(translate("en", "errors.printQuotaExceeded")).toMatch(/month.*credit/i);
    expect(translate("ar", "errors.printQuotaExceeded")).toMatch(/[\u0600-\u06FF]/u);
  });

  it("localizes definite printer admission failures without disguising them as service outages or generic conflicts", () => {
    const expectations = [
      ["PRINTER_OFFLINE", 503, "errors.printerOffline"],
      ["PRINTER_UNAVAILABLE", 409, "errors.printerCloudUnavailable"],
      ["PRINTER_UNVERIFIED", 409, "errors.printerVerificationRequired"],
      ["PRINTER_OWNER_CHANGED", 409, "errors.printerOwnerChanged"],
      ["TENANT_UNAVAILABLE", 403, "errors.workspaceUnavailable"],
      ["TENANT_SUSPENDED", 403, "errors.workspaceUnavailable"],
      ["TENANT_DELETED", 403, "errors.workspaceUnavailable"],
    ] as const;
    for (const [code, status, expectedKey] of expectations) {
      expect(codeMessageKey(code)).toBe(expectedKey);
      expect(apiMessageKey(code, status)).toBe(expectedKey);
      for (const locale of ["en", "ar"] as const) {
        const message = translate(locale, expectedKey);
        expect(message, `${locale} ${code}`).not.toBe(translate(locale, "errors.conflict"));
        expect(message, `${locale} ${code}`).not.toBe(translate(locale, "errors.serviceUnavailable"));
        expect(message, `${locale} ${code}`).not.toBe(translate(locale, "errors.billingBlocked"));
        expect(message, `${locale} ${code}`).not.toContain(code);
        if (locale === "ar") expect(message).toMatch(/\p{Script=Arabic}/u);
      }
    }
    expect(translate("en", "errors.printerOwnerChanged")).toMatch(/refresh.*confirm/i);
    expect(translate("ar", "errors.printerVerificationRequired")).toMatch(/تَحَق|تحقّق/u);
  });

  it("localizes invalid approved printer endpoints without telling operators to delete the printer", () => {
    expect(codeMessageKey("MISSING_PRINTER_ENDPOINT")).toBe("errors.printerEndpointMissing");
    expect(codeMessageKey("INVALID_PRINTER_ENDPOINT")).toBe("errors.printerEndpointInvalid");
    for (const locale of ["en", "ar"] as const) {
      const message = translate(locale, apiMessageKey("INVALID_PRINTER_ENDPOINT", 422));
      expect(message).not.toBe(translate(locale, "errors.printerEndpointMissing"));
      expect(message).not.toMatch(/remove it and add it again|أزلها ثم أعد إضافتها/i);
    }
    expect(translate("en", apiMessageKey("INVALID_PRINTER_ENDPOINT", 422))).toMatch(/review|verify/i);
    expect(translate("ar", apiMessageKey("INVALID_PRINTER_ENDPOINT", 422))).toMatch(/[\u0600-\u06ff]/u);
  });

  it("guides workspace approval and unsupported printer transport without blaming the Agent", () => {
    expect(codeMessageKey("DEVICE_NOT_APPROVED")).toBe("errors.deviceNotApproved");
    expect(codeMessageKey("UNSUPPORTED_DISCOVERY_TRANSPORT")).toBe("errors.unsupportedDiscoveryTransport");
    const pending = translate("en", apiMessageKey("DEVICE_NOT_APPROVED", 409));
    const unsupported = translate("en", apiMessageKey("UNSUPPORTED_DISCOVERY_TRANSPORT", 422));
    expect(pending).toMatch(/workspace|approve/i);
    expect(pending).not.toMatch(/on the agent/i);
    expect(unsupported).toMatch(/transport|protocol/i);
    expect(unsupported).not.toMatch(/update the agent/i);
    for (const code of ["DEVICE_NOT_APPROVED", "UNSUPPORTED_DISCOVERY_TRANSPORT"]) {
      const localized = translate("ar", apiMessageKey(code, code === "DEVICE_NOT_APPROVED" ? 409 : 422));
      expect(localized).toMatch(/[\u0600-\u06ff]/u);
      expect(localized).not.toBe(translate("ar", "errors.operationFailed"));
    }
  });

  it("resolves the ambiguous-invitation-delivery code", () => {
    // This code exists because the 503 is NOT a failure: the invitation row
    // was created and deliberately not revoked. Before it was added the
    // endpoint sent no code at all, so the client's codeMessageKey() branch
    // was unreachable and the operator saw a generic "Invitation failed".
    expect(codeMessageKey("INVITATION_DELIVERY_UNAVAILABLE")).toBe(
      "errors.invitationDeliveryUnavailable",
    );
  });

  it("tells the operator the invitation exists instead of claiming it failed", () => {
    const message = translate("en", "errors.invitationDeliveryUnavailable");
    // The dangerous copy is "failed": it tells the operator to send a second
    // invitation when the first link may already be in the invitee's inbox.
    expect(message.toLowerCase()).not.toContain("failed");
    expect(message.toLowerCase()).not.toContain("could not create");
    // It must state the two facts the operator needs: created, and unconfirmed.
    expect(message).toMatch(/created/i);
    expect(message).toMatch(/confirm/i);
    // And it must warn against the duplicate that would follow.
    expect(message).toMatch(/second/i);
  });

  it("keeps every code mapping pointing at a real catalogue entry", () => {
    // A code that maps to a missing key renders as the raw key string, which
    // is worse than the generic fallback it replaced.
    const source = fs.readFileSync("src/lib/api-error-keys.ts", "utf8");
    const mapped = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*"([^"]+)"/gm)];
    expect(mapped.length).toBeGreaterThan(30);
    for (const [, code, key] of mapped) {
      expect(key in en, `code ${code} maps to unknown key ${key}`).toBe(true);
    }
  });

  it("falls back to the HTTP status when a code is unknown, then to a caller fallback", () => {
    expect(statusMessageKey(503)).toBe("errors.serviceUnavailable");
    expect(codeMessageKey("NOT_A_REAL_CODE")).toBeNull();
    // Unknown code degrades to status, not to "everything is broken".
    expect(apiMessageKey("NOT_A_REAL_CODE", 503)).toBe("errors.serviceUnavailable");
    // No code and a status we do not describe -> the caller's own fallback.
    expect(apiMessageKey(undefined, 418, "team.invitationFailed")).toBe("team.invitationFailed");
  });
});

describe("invitation route honours the coded contract", () => {
  const route = fs.readFileSync("src/app/api/team/invitations/route.ts", "utf8");

  it("sends the delivery code alongside the 503", () => {
    // The client already reads `data.code` and maps it via codeMessageKey();
    // without this field that branch is dead code.
    expect(route).toContain('code: "INVITATION_DELIVERY_UNAVAILABLE"');
    expect(route).toContain("Invitation created; delivery unconfirmed");
    expect(route).toContain("requireWorkspaceOwnerForInvites");
  });

  it("gives idle expiry its own message and keeps the generic key for other session deaths", () => {
    expect(codeMessageKey("SESSION_IDLE_EXPIRED")).toBe("errors.sessionIdleExpired");
    expect(apiMessageKey("SESSION_IDLE_EXPIRED", 401)).toBe("errors.sessionIdleExpired");
    expect(codeMessageKey("SESSION_EXPIRED")).toBe("errors.sessionExpired");
    expect(apiMessageKey("SESSION_EXPIRED", 401)).toBe("errors.sessionExpired");
    for (const locale of ["en", "ar"] as const) {
      expect(translate(locale, "errors.sessionIdleExpired")).not.toBe(translate(locale, "errors.sessionExpired"));
      expect(translate(locale, "errors.sessionIdleExpired")).toMatch(locale === "ar" ? /30 دقيقة من عدم النشاط/ : /30 minutes without activity/);
    }
    expect(translate("en", "errors.sessionIdleExpired")).toBe(
      "You were signed out after 30 minutes without activity. Sign in again to continue.",
    );
    expect(translate("ar", "errors.sessionIdleExpired")).toBe(
      "تم تسجيل خروجك بعد 30 دقيقة من عدم النشاط. سجّل الدخول مرة أخرى للمتابعة.",
    );
  });

  it("keeps the renewed-session retry message short in both locales", () => {
    expect(translate("en", "errors.sessionRenewedRetry")).toBe(
      "Your session was renewed. Please send this again if you still want to.",
    );
    expect(translate("ar", "errors.sessionRenewedRetry")).toBe(
      "تم تجديد جلستك. أعد الإرسال إذا كنت ما زلت ترغب في المتابعة.",
    );
  });

  it("never revokes the invitation when email delivery is ambiguous", () => {
    // A provider timeout does not prove the mail was not accepted, so the
    // durable row must survive; revoking could invalidate a link the invitee
    // already received.
    const start = route.indexOf("await sendTransactionalEmail({");
    const end = route.indexOf("return NextResponse.json({ ok: true, id: inviteId }", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = route.slice(start, end);
    expect(block).toContain("code: \"INVITATION_DELIVERY_UNAVAILABLE\"");
    expect(block).not.toContain("set({ revokedAt:");
    expect(block).toContain("invitation_delivery_ambiguous");
    expect(block).not.toContain("revokedAt");
  });
});
