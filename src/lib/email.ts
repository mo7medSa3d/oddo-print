import { randomUUID } from "node:crypto";
import { runtimeSecret } from "./runtime-secret";

export type TransactionalEmail = { to: string; subject: string; html: string; text: string };

export function appBaseUrl(req: Request): string {
  const configured = runtimeSecret("APP_BASE_URL")?.trim().replace(/\/$/, "");
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new Error("APP_BASE_URL must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new Error("APP_BASE_URL must use HTTPS in production");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("APP_BASE_URL must not contain credentials, query parameters, or a fragment");
    }
    return parsed.toString().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "production") throw new Error("APP_BASE_URL is required in production");
  // Fail closed outside production too: deriving email/reset links or Stripe
  // redirect URLs from the Host header lets a poisoned Host point victims at
  // an attacker origin. Local development sets APP_BASE_URL (see
  // .env.example); only an explicit opt-in restores host-derived URLs.
  if (process.env.ALLOW_HOST_FALLBACK === "1") return new URL(req.url).origin;
  throw new Error("APP_BASE_URL is not configured; set it or opt into host-derived URLs with ALLOW_HOST_FALLBACK=1 for local development only");
}

export async function sendTransactionalEmail(message: TransactionalEmail): Promise<void> {
  const apiKey = runtimeSecret("RESEND_API_KEY");
  const from = runtimeSecret("EMAIL_FROM");
  if (!apiKey || !from) {
    throw new Error("Transactional email provider is not configured");
  }
  const maxAttempts = 3;
  // The provider supports idempotent POST /emails for 24 hours. Retry the
  // *same* logical operation with one key; generating a new key per attempt
  // risks duplicate invitations if an earlier 5xx was actually accepted.
  // Independent sends deliberately receive independent keys.
  const idempotencyKey = randomUUID();
  const body = JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text });
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // A transport timeout is NOT proof the provider did not accept the
      // email. Reuse the exact payload and idempotency key for every retry;
      // do not echo possibly sensitive transport details into UI errors.
      lastError = new Error("Transactional email provider did not respond");
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)));
        continue;
      }
      throw lastError;
    }
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    lastError = new Error(`Transactional email provider rejected the request (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    // Retry only on transient failures (5xx or 429 rate-limit).
    if (res.status !== 429 && res.status < 500) throw lastError;
    if (attempt < maxAttempts) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}