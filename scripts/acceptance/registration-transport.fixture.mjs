/** Only explicitly preloaded by platform-browser.mjs in its disposable DB.
 * The production application never imports this external-transport fixture.
 */
import assert from "node:assert/strict";

const database = new URL(process.env.DATABASE_URL || "postgresql://invalid/invalid");
const origin = new URL(process.env.APP_BASE_URL || "https://invalid");
if (process.env.YASEIR_REGISTRATION_ACCEPTANCE_FIXTURE !== "1" || process.env.HOSTNAME !== "127.0.0.1" ||
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !/^\/yaseir_browser_[a-f0-9]{16}$/.test(database.pathname) || origin.hostname !== "localhost") {
  throw new Error("Refusing registration transport fixture outside its isolated loopback acceptance database");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://api.pwnedpasswords.com" && /^\/range\/[A-F0-9]{5}$/.test(url.pathname)) {
    assert.equal(options?.headers?.["Add-Padding"], "true");
    return new Response(`${"F".repeat(35)}:1\r\n${"0".repeat(35)}:0\r\n`, { status: 200 });
  }
  if (url.href === "https://api.resend.com/emails") {
    const body = JSON.parse(options.body);
    assert.ok(body.to.every(address => address.endsWith("@example.invalid")));
    assert.ok(options.headers["Idempotency-Key"]);
    console.log(JSON.stringify({ event: "fixture.email.started", time: Date.now() }));
    await new Promise(resolve => setTimeout(resolve, 4000));
    console.log(JSON.stringify({ event: "fixture.email.completed", time: Date.now() }));
    return Response.json({ id: "synthetic-delivery-only" }, { status: 200 });
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Acceptance fixture refuses unexpected external fetch");
  return originalFetch(input, options);
};
