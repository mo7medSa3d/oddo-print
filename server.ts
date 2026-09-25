import { logError, logWarn } from "./src/lib/log";
import { createServer } from "http";
import type { Server as HttpServer } from "http";
import type { WebSocket, WebSocketServer } from "ws";
import { parse } from "url";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";
import { guardApiRequest } from "./src/server/request-guard";
import { applyApiCacheControlDefault } from "./src/server/api-defaults";
import { sweepPrintJobs } from "./src/lib/job-maintenance";
import { cleanupAuthRateLimits } from "./src/lib/auth-rate-limit";
import { cleanupExpiredManagerSessions } from "./src/lib/manager-auth";
import { cleanupExpiredRefreshTokens } from "./src/lib/session-tokens";
import { applyApiCors, handleApiCorsPreflight } from "./src/server/cors";
import { isTrustedProxyRequest, trustProxyEnabled } from "./src/server/trusted-proxy";
import { runtimeSecret } from "./src/lib/runtime-secret";
import { pool } from "./src/db";
import { sweepStaleAgentPresence, AGENT_PRESENCE_SWEEP_INTERVAL_MS } from "./src/lib/agent-presence-maintenance";
import {
  createRequestContentSecurityPolicy,
  shouldApplyPageContentSecurityPolicy,
} from "./src/server/content-security-policy";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

function isLoopbackBinding(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
const JOB_SWEEP_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

// Known example/placeholder secrets shipped in .env.example /
// .env.docker.example / the docs. They pass length checks, so they must be
// refused by exact match — a deployment that copies the example without
// editing it would otherwise run with a publicly known proxy-auth token
// (defeating forwarded-header trust) or a guessable session signing key.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "changeme-to-at-least-32-chars-random-string",
  "changeme-proxy-secret-at-least-32-chars-long",
  "replace-with-at-least-32-random-characters",
  "replace-with-another-at-least-32-random-secret",
]);

function assertRealSecret(name: string, value: string | undefined, minLength: number): string {
  if (!value || value.length < minLength) {
    throw new Error(`Refusing production startup: ${name} must be configured with a real secret of at least ${minLength} characters.`);
  }
  if (KNOWN_PLACEHOLDER_SECRETS.has(value.trim())) {
    throw new Error(`Refusing production startup: ${name} is a known example placeholder from the repository. Generate a real secret (>=${minLength} chars).`);
  }
  return value;
}

if (process.env.NODE_ENV === "production" && process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD === "1") {
  throw new Error("Refusing production startup with ALLOW_PLAINTEXT_MANAGER_PASSWORD=1; configure MANAGER_PASSWORD_HASH instead.");
}

if (process.env.NODE_ENV === "production" && (process.env.COOKIE_SECURE === "0" || process.env.COOKIE_SECURE === "false")) {
  throw new Error("Refusing production startup with COOKIE_SECURE disabled; manager/customer session cookies must be Secure in production.");
}

if (process.env.NODE_ENV === "production") {
  const platformTenantId = runtimeSecret("PLATFORM_TENANT_ID")?.trim();
  if (!platformTenantId || platformTenantId === "<required-platform-tenant-id>") {
    throw new Error("Refusing production startup: PLATFORM_TENANT_ID must be configured with the real platform workspace ID so the platform tenant cannot be suspended or deleted.");
  }
  assertRealSecret("GATEWAY_JWT_SECRET", runtimeSecret("GATEWAY_JWT_SECRET"), 32);
  if (!trustProxyEnabled() && !isLoopbackBinding(hostname)) {
    throw new Error("Refusing production startup: TRUST_PROXY=1 is required when the Gateway binds a non-loopback interface. Do not expose the Gateway application port directly.");
  }
  if (trustProxyEnabled()) {
    assertRealSecret("TRUST_PROXY_SECRET", runtimeSecret("TRUST_PROXY_SECRET"), 32);
  }
  const appBaseUrl = runtimeSecret("APP_BASE_URL")?.trim();
  if (!appBaseUrl) {
    throw new Error("Refusing production startup: APP_BASE_URL must be configured.");
  }
  let parsedAppBaseUrl: URL;
  try {
    parsedAppBaseUrl = new URL(appBaseUrl);
  } catch {
    throw new Error("Refusing production startup: APP_BASE_URL must be an absolute URL.");
  }
  if (
    parsedAppBaseUrl.protocol !== "https:" ||
    parsedAppBaseUrl.username ||
    parsedAppBaseUrl.password ||
    parsedAppBaseUrl.pathname !== "/" ||
    parsedAppBaseUrl.search ||
    parsedAppBaseUrl.hash
  ) {
    throw new Error("Refusing production startup: APP_BASE_URL must be a clean HTTPS origin.");
  }
}

let httpServer: HttpServer | null = null;
let agentWss: WebSocketServer | null = null;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: draining connections...`);
  const hardExit = setTimeout(() => {
    logError("[shutdown] drain window elapsed; exiting (leases and the agent ledger make interrupted deliveries safe — jobs never silently reprint)");
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
  hardExit.unref();
  // Close agent WebSockets FIRST so agents fail over to their poll path with
  // a clean 1001 instead of a TCP reset mid-frame; this also releases the
  // LISTEN connection owned by the notification listener (wss 'close' hook).
  // NOTE: WebSocketServer.close() takes only an optional callback — the
  // close code/reason is a per-socket API, so each client is closed
  // individually before the server itself is shut down.
  try {
    agentWss?.clients.forEach((client: WebSocket) => {
      try {
        client.close(1001, "gateway shutting down");
      } catch { /* already closing */ }
    });
  } catch { /* already closed */ }
  try { agentWss?.close(); } catch { /* already closed */ }
  if (!httpServer) {
    void pool.end().finally(() => process.exit(0));
    return;
  }
  httpServer.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (shouldApplyPageContentSecurityPolicy(req.url)) {
      const { nonce, policy } = createRequestContentSecurityPolicy();
      req.headers["x-nonce"] = nonce;
      res.setHeader("Content-Security-Policy", policy);
    }

    applyApiCacheControlDefault(req, res);
    if (trustProxyEnabled() && req.url !== "/api/health" && req.url !== "/api/live") {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const protocolReq = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
      });
      if (!isTrustedProxyRequest(protocolReq)) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "TRUSTED_PROXY_REQUIRED" }));
        return;
      }
    }

    if (handleApiCorsPreflight(req, res)) return;
    applyApiCors(req, res);

    guardApiRequest(req, res)
      .then((guarded) => {
        if (!guarded) return;
        handle(guarded as any, res as any);
      })
      .catch((error) => {
        logError("[request-guard] failed to process request", { error: error });
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
        }
        req.destroy();
      });
  });

  httpServer = server;
  agentWss = attachAgentWSS(server);

  const sweep = () => {
    sweepPrintJobs().catch((error) => {
      logError("[job-maintenance] sweep failed", { error: error });
    });
  };
  sweep();
  const sweepTimer = setInterval(sweep, JOB_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const housekeeping = () => {
    Promise.all([
      cleanupAuthRateLimits(),
      cleanupExpiredManagerSessions(),
      cleanupExpiredRefreshTokens(),
    ]).catch((error) => {
      logError("[auth-maintenance] cleanup failed", { error: error });
    });
  };
  housekeeping();
  const housekeepingTimer = setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS);
  housekeepingTimer.unref();

  const presenceSweep = () => {
    sweepStaleAgentPresence().catch((error) => {
      logError("[agent-presence] stale-agent sweep failed", { error: error });
    });
  };
  presenceSweep();
  const presenceTimer = setInterval(presenceSweep, AGENT_PRESENCE_SWEEP_INTERVAL_MS);
  presenceTimer.unref();

  if (trustProxyEnabled()) {
    logWarn("[security] TRUST_PROXY enabled: only requests carrying the proxy authentication token are trusted for forwarded-client-IP handling. The bundled Caddyfile injects the token and overwrites X-Forwarded-For.");
  }

  server.listen(port, hostname, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    console.log(`> Ready on http://${hostname}:${boundPort} (Agent WS at /api/agent/ws)`);
  });
});
