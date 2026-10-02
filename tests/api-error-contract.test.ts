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
    expect(route).toContain("Invitation delivery is temporarily unavailable");
  });

  it("never revokes the invitation when email delivery is ambiguous", () => {
    // A provider timeout does not prove the mail was not accepted, so the
    // durable row must survive; revoking could invalidate a link the invitee
    // already received.
    const start = route.indexOf("await sendTransactionalEmail({");
    const end = route.indexOf("return NextResponse.json({ ok: true, id });", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = route.slice(start, end);
    expect(block).toContain("code: \"INVITATION_DELIVERY_UNAVAILABLE\"");
    expect(block).not.toContain("set({ revokedAt:");
    expect(block).toContain("Never revoke the durable invitation");
  });
});
