import { derivePhysicalOutcome } from "./job-status";
import { deriveSubmissionState } from "./submission-evidence";

/** Every job prints on physical hardware: the presentation carries the
 * physical outcome and the spooler submission state. (File-output jobs
 * no longer exist — there is no PDF file-output printer type.) */
export function printOutputPresentation(row: { status: string; error?: string | null; outputMedium?: string | null; outputEvidence?: unknown; submissionEvidence?: unknown }) {
  return { outputMedium: "physical" as const, physicalOutcome: derivePhysicalOutcome(row.status, row.error), outputEvidence: null, submissionState: deriveSubmissionState(row.status, row.outputMedium, row.submissionEvidence) };
}
