/**
 * One logical diagnostic test-print intent across Gateway/desktop renderer retries.
 * This is deliberately dependency-free so both renderers use identical rules.
 * No local state is evidence of physical paper output. Gateway idempotency and
 * authenticated, tenant-scoped durable receipts remain authoritative.
 */
export type DiagnosticJobStatus = "queued" | "claimed" | "printing" | "success" | "failed" | "expired";
export type DiagnosticPhysicalOutcome = "printed" | "not_printed" | "unknown";

export interface DiagnosticResult {
  ok: true;
  jobId: string;
  printerId: string;
  status: DiagnosticJobStatus;
  virtualCapture: boolean;
  isReused: boolean;
  physicalOutcome: DiagnosticPhysicalOutcome | null;
}

export class InvalidDiagnosticResponse extends Error {
  readonly code = "INVALID_DIAGNOSTIC_RESPONSE";
  constructor() {
    super("The Gateway diagnostic response could not be verified");
    this.name = "InvalidDiagnosticResponse";
  }
}

const STATUSES: readonly string[] = ["queued", "claimed", "printing", "success", "failed", "expired"];
const OUTCOMES: readonly string[] = ["printed", "not_printed", "unknown"];

/** Validate *before* describing a 2xx as accepted, including identity and replay. */
export function decodeDiagnosticResult(value: unknown, printerId: string): DiagnosticResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDiagnosticResponse();
  const row = value as Record<string, unknown>;
  if (row.ok !== true || typeof row.jobId !== "string" || !row.jobId.trim() ||
      typeof row.printerId !== "string" || row.printerId !== printerId ||
      typeof row.status !== "string" || !STATUSES.includes(row.status) ||
      (row.virtualCapture !== undefined && typeof row.virtualCapture !== "boolean") ||
      (row.isReused !== undefined && typeof row.isReused !== "boolean") ||
      (row.physicalOutcome !== undefined && row.physicalOutcome !== null &&
       (typeof row.physicalOutcome !== "string" || !OUTCOMES.includes(row.physicalOutcome)))) {
    throw new InvalidDiagnosticResponse();
  }
  return {
    ok: true,
    jobId: row.jobId,
    printerId,
    status: row.status as DiagnosticJobStatus,
    virtualCapture: row.virtualCapture === true,
    isReused: row.isReused === true,
    physicalOutcome: (row.physicalOutcome ?? null) as DiagnosticPhysicalOutcome | null,
  };
}

/** Actor/workspace scope must be provided by authenticated caller, not printer metadata. */
export function diagnosticScope(origin: string, actorScope: string, printerId: string): string {
  return JSON.stringify([origin.trim().replace(/\/+$/, "").toLowerCase(), actorScope, printerId]);
}

interface Operation { key: string; observed: DiagnosticResult | null }

/** Synchronous lock is taken before the first await: React state is not a lock. */
export class DiagnosticOperations {
  private readonly entries = new Map<string, Operation>();
  private readonly flights = new Set<string>();

  private readonly createKey: () => string;
  constructor(createKey: () => string) { this.createKey = createKey; }

  begin(scope: string): string | null {
    if (this.flights.has(scope)) return null;
    const existing = this.entries.get(scope);
    if (!existing) {
      const key = this.createKey();
      if (typeof key !== "string" || key.trim().length < 8 || key.length > 200) {
        throw new Error("A valid diagnostic operation identity could not be created");
      }
      this.entries.set(scope, { key, observed: null });
    }
    this.flights.add(scope);
    return this.entries.get(scope)!.key;
  }

  /** Valid response retains evidence until the operator explicitly starts another print. */
  observed(scope: string): DiagnosticResult | null {
    return this.entries.get(scope)?.observed ?? null;
  }

  accept(scope: string, result: DiagnosticResult): void {
    const entry = this.entries.get(scope);
    if (!entry || !this.flights.has(scope)) throw new Error("No matching diagnostic request is in flight");
    entry.observed = result;
    this.flights.delete(scope);
  }

  /** Transport loss, malformed 2xx, HTTP errors and ambiguous outcomes keep key. */
  uncertain(scope: string): void {
    this.flights.delete(scope);
  }

  /** Must be called only after explicit operator confirmation of physical repeat. */
  confirmRepeat(scope: string): boolean {
    const entry = this.entries.get(scope);
    if (!entry?.observed || this.flights.has(scope)) return false;
    this.entries.delete(scope);
    return true;
  }
}

export type DiagnosticMessageKey =
  | "diagnostic.queued" | "diagnostic.virtualQueued" | "diagnostic.inProgress"
  | "diagnostic.delivered" | "diagnostic.virtualCaptured" | "diagnostic.failed" | "diagnostic.expired"
  | "diagnostic.unverified";

/** Refresh a previously accepted diagnostic with its SAME operation key.
 * Never silently create a second physical print while a prior job is active. */
export function diagnosticIsInProgress(result: DiagnosticResult): boolean {
  return result.status === "queued" || result.status === "claimed" || result.status === "printing";
}

export function diagnosticMessageKey(result: DiagnosticResult): DiagnosticMessageKey {
  if (result.status === "queued") return result.virtualCapture ? "diagnostic.virtualQueued" : "diagnostic.queued";
  if (result.status === "claimed" || result.status === "printing") return "diagnostic.inProgress";
  if (result.status === "success") return result.virtualCapture ? "diagnostic.virtualCaptured" : "diagnostic.delivered";
  if (result.physicalOutcome === "not_printed") {
    return result.status === "expired" ? "diagnostic.expired" : "diagnostic.failed";
  }
  return "diagnostic.unverified";
}

export function diagnosticMessageType(result: DiagnosticResult): "ok" | "err" {
  return result.status === "failed" || result.status === "expired" ? "err" : "ok";
}
