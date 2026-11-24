import { logError, logWarn, logInfo } from "./src/lib/log";
import { createPrivateKey } from "node:crypto";
import { createServer } from "http";
import type { Server as HttpServer } from "http";
import next from "next";
import { guardApiRequest, guardHttpMethod, observeAuthorizationDenials, recordAuthorizationDenial, flushAuthorizationDenials } from "./src/server/request-guard";
import { applyApiCacheControlDefault, applyHttpSecurityHeaders, handleHttpClientError } from "./src/server/api-defaults";
import { cleanupAuthRateLimits } from "./src/lib/auth-rate-limit";
import { cleanupExpiredManagerSessions } from "./src/lib/manager-auth";
import { cleanupExpiredPlatformSessions } from "./src/lib/platform-auth";
import { cleanupExpiredRefreshTokens } from "./src/lib/session-tokens";
import { applyApiCors, handleApiCorsPreflight } from "./src/server/cors";
import { isTrustedProxyRequest, trustProxyEnabled } from "./src/server/trusted-proxy";
import { requestPath } from "./src/server/request-path";
import { runtimeSecret } from "./src/lib/runtime-secret";
import { pool } from "./src/db";
import { createRequestContentSecurityPolicy, shouldApplyPageContentSecurityPolicy } from "./src/server/content-security-policy";
import { assertMetricsMachineConfiguration } from "./src/lib/metrics-machine-auth";
import { generateRequestId, runWithCorrelation } from "./src/server/correlation";

const dev = process.env.NODE_ENV === "development";
const rawPort = process.env.PORT ?? "3000";
const port = /^\d+$/.test(rawPort.trim()) ? parseInt(rawPort.trim(), 10) : NaN;
// 0 is valid (OS-assigned ephemeral port, used by the multi-instance
// integration test); anything else must be a real port number.
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Refusing startup: PORT must be an integer 0..65535 (got ${JSON.stringify(rawPort)}).`);
}
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

function isLoopbackBinding(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;
// A bounded mail task may perform three ten-second attempts plus 1s/2s
// retry delays. Leave room to drain accepted Next after() work before exit.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 45_000;
// Keep keepAliveTimeout < headersTimeout < requestTimeout per Node HTTP invariants,
// above reverse-proxy idle/header timeouts while bounding slowloris/hung sockets.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
const REQUEST_TIMEOUT_MS = 70_000;

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

const plaintextManagerPasswordAllowedEnvironment = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
assertMetricsMachineConfiguration();
if (!plaintextManagerPasswordAllowedEnvironment && process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD === "1") {
  throw new Error("Refusing startup with ALLOW_PLAINTEXT_MANAGER_PASSWORD=1 outside development/test; configure MANAGER_PASSWORD_HASH instead.");
}

if (process.env.NODE_ENV === "production" && ["0", "false", "no", "off"].includes((process.env.COOKIE_SECURE ?? "").trim().toLowerCase())) {
  throw new Error("Refusing production startup with COOKIE_SECURE disabled; manager/customer session cookies must be Secure in production.");
}

if (process.env.NODE_ENV === "production") {
  const platformTenantId = runtimeSecret("PLATFORM_TENANT_ID")?.trim();
  if (!platformTenantId || platformTenantId === "<required-platform-tenant-id>") {
    throw new Error("Refusing production startup: PLATFORM_TENANT_ID must be configured with the real platform workspace ID so the platform tenant cannot be suspended or deleted.");
  }
  // Do not advertise a production Gateway with a dummy PostgreSQL pool.
  // A database URL or the complete structured connection identity is
  // required. Local/test module imports remain free of deployment settings.
  const configuredDatabaseUrl = runtimeSecret("DATABASE_URL")?.trim();
  const structuredDatabase = Boolean(
    process.env.PGHOST?.trim() &&
    process.env.PGUSER?.trim() &&
    process.env.PGDATABASE?.trim()
  );
  if (!configuredDatabaseUrl && !structuredDatabase) {
    throw new Error("Refusing production startup: DATABASE_URL or PGHOST, PGUSER and PGDATABASE are required.");
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
  const licenseKeyPem = runtimeSecret("LICENSE_SIGNING_PRIVATE_KEY_PEM");
  if (!licenseKeyPem) {
    logWarn("gateway.startup.license_signing_unconfigured", {
      message: "LICENSE_SIGNING_PRIVATE_KEY_PEM is not configured; license endpoints will return 503.",
    });
  } else {
    try {
      const signingKey = createPrivateKey(licenseKeyPem);
      if (signingKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Ed25519 private key required");
      }
    } catch (error) {
      throw new Error(
        `Refusing production startup: LICENSE_SIGNING_PRIVATE_KEY_PEM is invalid (${error instanceof Error ? error.message : "unparseable PEM"}).`,
      );
    }
  }
}

let httpServer: HttpServer | null = null;
let housekeepingTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
const maintenanceTasks = new Set<Promise<unknown>>();
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveRequestId(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-request-id"] ?? headers["x-correlation-id"];
  const candidate = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return candidate && SAFE_REQUEST_ID_RE.test(candidate) ? candidate : generateRequestId();
}

function maintenanceTask(operation: () => Promise<unknown>, failureEvent: string): () => void {
  let running = false;
  return () => {
    if (running || shuttingDown) return;
    running = true;
    const task = Promise.resolve().then(operation)
      .catch((error) => logError(failureEvent, { error }))
      .finally(() => { running = false; maintenanceTasks.delete(task); });
    maintenanceTasks.add(task);
  };
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (housekeepingTimer) {
    clearInterval(housekeepingTimer);
    housekeepingTimer = null;
  }
  logInfo("gateway.shutdown.draining", { signal });
  const hardExit = setTimeout(() => {
    logError("[shutdown] drain window elapsed; exiting");
    flushAuthorizationDenials();
    process.exit(1);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
  hardExit.unref();
  // Drain active HTTP connections, Next after() work, and maintenance tasks
  // before ending the PostgreSQL pool.
  void (async () => {
    await new Promise<void>((resolve) => {
      if (!httpServer) { resolve(); return; }
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections?.();
    });
    // Next owns after()/waitUntil callbacks accepted before HTTP responses
    // completed. Its close hook waits for those tasks; process.exit or ending
    // PostgreSQL first would silently abandon accepted verification delivery.
    await app.close();
    // Maintenance can be between statements while HTTP finishes
    // draining. Keep the pool available until those accepted tasks complete;
    // the shutdown deadline still bounds a genuinely stalled transaction.
    await Promise.allSettled([...maintenanceTasks]);
    flushAuthorizationDenials();
    await pool.end();
    clearTimeout(hardExit);
    process.exit(0);
  })().catch((error) => {
    logError("gateway.shutdown.failed", { error });
    process.exit(1);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // Defense-in-depth against Next.js middleware bypass (CVE-2025-29927).
    delete req.headers["x-middleware-subrequest"];
    const requestId = resolveRequestId(req.headers);
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);
    runWithCorrelation({ requestId }, () => {
    observeAuthorizationDenials(res);
    applyHttpSecurityHeaders(res);
    applyApiCacheControlDefault(req, res);
    if (shuttingDown) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "connection": "close", "retry-after": "1" });
      res.end(JSON.stringify({ error: "GATEWAY_SHUTTING_DOWN" }));
      return;
    }
    if (!guardHttpMethod(req, res)) return;
    // This repository uses the custom Node server as the actual HTTP entrypoint.
    // Generate exactly one request-scoped nonce here, expose it to the Next
    // renderer through the request headers, and send the same policy to the
    // browser. The separate proxy.ts CSP path is intentionally not used here.
    if (shouldApplyPageContentSecurityPolicy(req.url)) {
      const { nonce, policy } = createRequestContentSecurityPolicy();
      // Next derives its automatic script nonces from the request CSP header.
      // Keep the custom x-nonce too so application Server Components can read
      // the same value; both are generated once for this request.
      req.headers["x-nonce"] = nonce;
      req.headers["content-security-policy"] = policy;
      res.setHeader("Content-Security-Policy", policy);
    }

    // Load-balancer liveness probes bypass proxy trust. Match on the URL
    // pathname: req.url carries the query string, so an exact-string match
    // would inconsistently gate /api/health?x=1 while exempting /api/health.
    const probePath = requestPath(req.url);
    if (trustProxyEnabled() && probePath !== "/api/health" && probePath !== "/api/live") {
      if (!isTrustedProxyRequest(req)) {
        recordAuthorizationDenial("http", 400);
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
        return handle(guarded as any, res as any);
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
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.on("clientError", handleHttpClientError);

  httpServer = server;


  const housekeeping = maintenanceTask(async () => {
    const results = await Promise.allSettled([
      cleanupAuthRateLimits(),
      cleanupExpiredManagerSessions(),
      cleanupExpiredPlatformSessions(),
      cleanupExpiredRefreshTokens(),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }, "[auth-maintenance] cleanup failed");
  housekeeping();
  housekeepingTimer = setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS);
  housekeepingTimer.unref();


  if (trustProxyEnabled()) {
    logWarn("[security] TRUST_PROXY enabled: only requests carrying the proxy authentication token are trusted for forwarded-client-IP handling. The bundled Caddyfile injects the proxy token and overwrites X-Forwarded-For with the real client address.");
  }

  server.listen(port, hostname, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    logInfo("gateway.startup.ready", { hostname, port: boundPort });
  });
}).catch((error) => {
  logError("[startup] Next.js prepare failed; refusing to run without a request handler", { error: error instanceof Error ? error.message : String(error) });
  try { void pool.end(); } catch { /* already closed */ }
  process.exit(1);
});
