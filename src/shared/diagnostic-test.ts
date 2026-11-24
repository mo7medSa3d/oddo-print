/**
 * Diagnostic test-print response decoder shared by the desktop renderer.
 * No local state is evidence of physical paper output.
 */
type DiagnosticJobStatus = "queued" | "claimed" | "printing" | "success" | "failed" | "expired" | "unknown" | "canceled";
type DiagnosticPhysicalOutcome = "printed" | "not_printed" | "unknown";

export interface DiagnosticResult {
  ok: true;
  jobId: string;
  printerId: string;
  status: DiagnosticJobStatus;
  isReused: boolean;
  physicalOutcome: DiagnosticPhysicalOutcome | null;
}

class InvalidDiagnosticResponse extends Error {
  readonly code = "INVALID_DIAGNOSTIC_RESPONSE";
  constructor() {
    super("The diagnostic response could not be verified");
    this.name = "InvalidDiagnosticResponse";
  }
}

const STATUSES: readonly string[] = ["queued", "claimed", "printing", "success", "failed", "expired", "unknown", "canceled"];
const OUTCOMES: readonly string[] = ["printed", "not_printed", "unknown"];

/** Validate *before* describing a 2xx as accepted, including identity and replay. */
export function decodeDiagnosticResult(value: unknown, printerId: string): DiagnosticResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDiagnosticResponse();
  const row = value as Record<string, unknown>;
  if (row.ok !== true || typeof row.jobId !== "string" || !row.jobId.trim() ||
      typeof row.printerId !== "string" || row.printerId !== printerId ||
      typeof row.status !== "string" || !STATUSES.includes(row.status) ||
      (row.virtualCapture !== undefined && row.virtualCapture !== false) ||
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
    isReused: row.isReused === true,
    physicalOutcome: (row.physicalOutcome ?? null) as DiagnosticPhysicalOutcome | null,
  };
}
