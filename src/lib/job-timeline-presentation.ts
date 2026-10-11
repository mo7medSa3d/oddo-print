/** Operator presentation for durable timeline records.
 *
 * Legacy Agents/Gateways wrote `stage=printing` with `status=ok` even though
 * the event meant admission, before renderer or printer I/O. Keep the stored
 * audit evidence immutable and correct only its display interpretation.
 */
export function persistedTimelinePresentation(event: { stage: string; status: string }) {
  if (event.stage === "printing") {
    return {
      status: "pending",
      messageKey: "job.timeline.printingAdmitted" as const,
    };
  }
  return { status: event.status, messageKey: null };
}
