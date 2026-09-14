import { runtimeSecret } from "./runtime-secret";

export type TransactionalEmail = { to: string; subject: string; html: string; text: string };

export async function sendTransactionalEmail(message: TransactionalEmail): Promise<void> {
  const apiKey = runtimeSecret("RESEND_API_KEY");
  const from = runtimeSecret("EMAIL_FROM");
  if (!apiKey || !from) {
    throw new Error("Transactional email provider is not configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transactional email provider rejected the request (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}

export function appBaseUrl(req: Request): string {
  const configured = runtimeSecret("APP_BASE_URL")?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("APP_BASE_URL is required in production");
  return new URL(req.url).origin;
}
