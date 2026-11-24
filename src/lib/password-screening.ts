import { createHash } from "node:crypto";
import commonPasswordHashes from "./common-password-hashes.json";
import { isValidNewPasswordLength } from "./new-password-policy";

// HIBP range protocol: only a 20-bit SHA-1 prefix leaves the server. SHA-1
// here is a lookup protocol, never a password-storage algorithm. Passwords
// remain Argon2id-hashed by password.ts. No password, full digest, suffix,
// account identity or provider response is logged or cached.
// https://haveibeenpwned.com/API/v3#PwnedPasswords
const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;
const MAX_IN_FLIGHT = 8;
let inFlight = 0;
const commonPasswords = new Set(commonPasswordHashes);
// Public, documented product/context words; punctuation, digits, marks and casing
// must not make an otherwise predictable product-name password acceptable.
// This comparison never changes the password supplied to the storage KDF.
const CONTEXT_WORDS = /^(?:yaseir|yasser|odoo|print|printing|cloud|gateway|admin|administrator|يسير)+$/u;

export type PasswordScreeningResult = "acceptable" | "compromised" | "unavailable";

export async function screenNewPassword(password: string): Promise<PasswordScreeningResult> {
  if (!isValidNewPasswordLength(password)) {
    return "unavailable";
  }
  const context = password.normalize("NFKC").toLowerCase().replace(/[\p{N}\p{P}\p{S}\p{Z}\p{C}\p{M}]/gu, "");
  if (commonPasswords.has(createHash("sha256").update(password, "utf8").digest("hex")) || CONTEXT_WORDS.test(context)) {
    return "compromised";
  }
  if (inFlight >= MAX_IN_FLIGHT) return "unavailable";
  inFlight++;
  const controller = new AbortController();
  // The deadline covers response streaming, not just the initial headers.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${RANGE_URL}${digest.slice(0, 5)}`, {
      method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { "Add-Padding": "true", "User-Agent": "Yaseir-Password-Screening/1.0", Accept: "text/plain" },
    });
    if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return "unavailable";
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES || controller.signal.aborted) return "unavailable";
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (controller.signal.aborted || !text.trim()) return "unavailable";
    const suffix = digest.slice(5);
    let compromised = false;
    let realEntries = 0;
    for (const line of text.trim().split(/\r?\n/)) {
      // Refuse malformed/empty/truncated data instead of interpreting it as
      // a clean password. Zero-count entries are HIBP privacy padding.
      const entry = /^([A-F0-9]{35}):(\d{1,12})$/i.exec(line);
      if (!entry) return "unavailable";
      if (Number(entry[2]) > 0) {
        realEntries++;
        if (entry[1].toUpperCase() === suffix) compromised = true;
      }
    }
    if (!realEntries) return "unavailable";
    return compromised ? "compromised" : "acceptable";
  } catch {
    // Fixed outcome only: provider exceptions can contain URL/body details.
    return "unavailable";
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    inFlight--;
  }
}

export function passwordScreeningFailure(result: PasswordScreeningResult): { status: number; body: { error: string; code: string } } | null {
  if (result === "acceptable") return null;
  return result === "compromised"
    ? { status: 400, body: { error: "This password is too common, predictable, or has appeared in a data breach. Choose a different password.", code: "PASSWORD_COMPROMISED" } }
    : { status: 503, body: { error: "Password safety checking is temporarily unavailable. Try again shortly.", code: "PASSWORD_SCREENING_UNAVAILABLE" } };
}
