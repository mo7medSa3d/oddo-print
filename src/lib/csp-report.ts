import { parseStrictContentLength } from "./request-limits";

// One process-wide budget, with no caller-keyed map, DB writes or credentials.
// Reports are attacker-controlled observations and may be dropped under load.
const MAX_REPORT_BYTES = 16 * 1024;
const READ_DEADLINE_MS = 2_000;
const MAX_IN_FLIGHT = 8;
const MAX_ATTEMPTS_PER_WINDOW = 60;
const WINDOW_MS = 60_000;
let windowStarted = performance.now();
let attempts = 0;
let inFlight = 0;

const DIRECTIVES = new Set([
  "base-uri", "child-src", "connect-src", "default-src", "font-src",
  "form-action", "frame-ancestors", "frame-src", "img-src", "manifest-src",
  "media-src", "object-src", "prefetch-src", "require-trusted-types-for",
  "sandbox", "script-src", "script-src-attr", "script-src-elem", "style-src",
  "style-src-attr", "style-src-elem", "trusted-types", "worker-src",
]);

type SafeReport = { directive: string; disposition: "enforce" | "report"; status: number };

class InvalidReport extends Error {
  constructor(readonly status: number) { super("Invalid CSP report"); }
}

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
}

function reserve(): boolean {
  const now = performance.now();
  if (now - windowStarted >= WINDOW_MS) {
    windowStarted = now;
    attempts = 0;
  }
  if (attempts >= MAX_ATTEMPTS_PER_WINDOW || inFlight >= MAX_IN_FLIGHT) return false;
  attempts += 1;
  inFlight += 1;
  return true;
}

function safeReport(value: unknown): SafeReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidReport(400);
  const report = (value as Record<string, unknown>)["csp-report"];
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new InvalidReport(400);
  const fields = report as Record<string, unknown>;
  const directive = fields["effective-directive"];
  const disposition = fields.disposition;
  const status = fields["status-code"];
  if (typeof directive !== "string" || !DIRECTIVES.has(directive)
    || (disposition !== "enforce" && disposition !== "report")
    || typeof status !== "number" || !Number.isInteger(status)
    || (status !== 0 && (status < 100 || status > 599))) throw new InvalidReport(400);
  // Never return, log, fetch or retain the source report: URLs, query tokens,
  // policy nonces, source samples and all caller-supplied metadata are ignored.
  return { directive, disposition, status };
}

async function readReport(req: Request): Promise<SafeReport> {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/csp-report" || (encoding && encoding !== "identity")) throw new InvalidReport(415);
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const size = parseStrictContentLength(declared);
    if (size === null) throw new InvalidReport(400);
    if (size > MAX_REPORT_BYTES) throw new InvalidReport(413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new InvalidReport(400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new InvalidReport(408)), READ_DEADLINE_MS);
    timer.unref?.();
  });
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPORT_BYTES) throw new InvalidReport(413);
      chunks.push(value);
    }
    complete = true;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    return safeReport(JSON.parse(json));
  } finally {
    if (timer) clearTimeout(timer);
    // A stalled or hostile stream's cancel callback must not hold the slot or
    // response open beyond the deadline. Do not await its cancellation promise.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function handleCspReport(req: Request): Promise<Response> {
  if (!reserve()) {
    if (req.body && !req.body.locked) void req.body.cancel().catch(() => undefined);
    return response(429);
  }
  try {
    const fields = await readReport(req);
    // The general logger automatically attaches request/tenant correlation.
    // This telemetry deliberately emits only fixed metadata and allowlisted
    // fields, with no request identity or error text, even inside such a scope.
    console.info(JSON.stringify({
      ts: new Date().toISOString(), event: "security.csp_violation", ...fields,
    }));
    return response(204);
  } catch (error) {
    if (req.body && !req.body.locked) void req.body.cancel().catch(() => undefined);
    return response(error instanceof InvalidReport ? error.status : 400);
  } finally {
    inFlight -= 1;
  }
}
