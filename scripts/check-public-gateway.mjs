#!/usr/bin/env node
/**
 * External release acceptance for the public Gateway TLS and WebSocket boundary.
 * Execute on an operator machine, not inside the trusted Docker overlay.
 * Node fetch and ws validate certificates against the OS/Node trust store.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function publicGatewayOrigin(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Public Gateway HTTPS origin is required");
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error("Invalid public Gateway HTTPS URL"); }
  if (
    parsed.protocol !== "https:" || !parsed.hostname ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash
  ) {
    throw new Error("Supply a clean HTTPS origin without credentials, query, fragment or API path");
  }
  return parsed.origin;
}

export async function checkPublicGateway(input) {
  const origin = publicGatewayOrigin(input);
  const health = await fetch(origin + "/api/health", {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (health.status !== 200) throw new Error(`Public HTTPS readiness rejected (HTTP ${health.status}); redirect or unhealthy database`);
  const body = await health.json();
  if (body?.ok !== true) throw new Error("Public Gateway health response was not ready");

  // The authenticated WebSocket endpoint must return 401 when reached through
  // the public TLS proxy without an Agent credential.
  await new Promise((resolveReady, rejectReady) => {
    const ws = new WebSocket("wss://" + new URL(origin).host + "/api/agent/ws", {
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      ws.terminate();
      if (error) rejectReady(error); else resolveReady();
    };
    ws.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status === 401) finish();
      else finish(new Error(`Unexpected unauthenticated WSS handshake status: ${status}`));
    });
    ws.once("open", () => finish(new Error("Unauthenticated WebSocket was unexpectedly accepted")));
    ws.once("error", (error) => finish(error));
    ws.once("close", () => {
      if (!settled) finish(new Error("WSS connection closed without an authentication refusal"));
    });
  });
  return { httpsReady: true, authenticatedWssBoundary: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkPublicGateway(process.argv[2] ?? process.env.APP_BASE_URL)
    .then(() => { console.info("PASS: trusted public HTTPS, DB readiness and protected WSS upgrade"); })
    .catch((error) => {
      console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
