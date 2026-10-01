/**
 * Map a failed Gateway API response to a translated message key.
 *
 * The API returns stable, machine-readable `code` values next to a
 * human-readable English `error` string. Showing that string directly was
 * convenient but wrong in two ways: it cannot be translated, so an Arabic
 * console answered in English; and it is written for logs, so it leaks
 * phrasing like "job id is required" instead of telling the operator what to
 * do.
 *
 * Codes are part of the API contract and are safe to depend on. Anything
 * unrecognised falls back to the HTTP status, which is also a contract, and
 * then to a generic failure message.
 */
import type { MessageKey } from "../i18n/messages/en";

/** Gateway error code → the message the operator should read. */
const CODE_KEYS: Record<string, MessageKey> = {
  // Jobs
  JOB_NOT_FOUND: "errors.jobNotFound",
  JOB_NOT_TERMINAL: "errors.jobStillInProgress",
  JOB_REPRINT_NOT_ALLOWED: "errors.jobNotEligibleForReprint",
  INVALID_STATUS_FILTER: "errors.invalidStatusFilter",
  // Agents
  AGENT_NOT_FOUND: "errors.agentNotFound",
  AGENT_ID_REQUIRED: "errors.agentIdRequired",
  AGENT_OFFLINE: "errors.agentOffline",
  AGENT_QUEUE_FULL: "errors.agentQueueFull",
  AGENT_STILL_CONNECTED: "errors.agentStillConnected",
  AGENT_HAS_HISTORY: "errors.agentHasHistory",
  LIFECYCLE_CONFLICT: "errors.lifecycleConflict",
  // Printers
  PRINTER_NOT_FOUND: "errors.printerNotFound",
  PRINTER_OWNER_MISSING: "errors.printerOwnerMissing",
  PRINTER_INVALID_LIFECYCLE: "errors.printerInvalidLifecycle",
  PRINTER_TRANSITION_BLOCKED: "errors.printerTransitionBlocked",
  PRINTER_LIFECYCLE_CONFLICT: "errors.printerLifecycleConcurrent",
  MISSING_PRINTER_ENDPOINT: "errors.printerEndpointMissing",
  INVALID_PRINTER_ENDPOINT: "errors.printerEndpointMissing",
  CAPABILITY_MISMATCH: "errors.capabilityMismatch",
  CAPABILITY_LOOKUP_FAILED: "errors.capabilityLookupFailed",
  DEVICE_NOT_APPROVED: "errors.deviceNotApproved",
  UNSUPPORTED_DISCOVERY_TRANSPORT: "errors.unsupportedDiscoveryTransport",
  // Billing and plans
  TENANT_ENTITLEMENT_EXCEEDED: "errors.billingBlocked",
  TENANT_SUBSCRIPTION_REQUIRED: "errors.billingBlocked",
  TENANT_ENTITLEMENT_CONFIG_ERROR: "errors.billingBlocked",
  // Request shape
  INVALID_REQUEST: "errors.requestRejected",
  INVALID_BODY: "errors.requestRejected",
  INVALID_PAYLOAD: "errors.requestRejected",
  INVALID_PRINTER: "errors.requestRejected",
  IDEMPOTENCY_CONFLICT: "errors.idempotencyConflict",
  API_KEY_READ_ONLY: "errors.apiKeyReadOnly",
  INTERNAL_ERROR: "errors.internalError",
};

/**
 * HTTP status → message, used when the code is unknown or absent. Returns
 * `null` for statuses this map does not describe, so callers keep their own
 * more specific fallback.
 */
export function statusMessageKey(status: number): MessageKey | null {
  if (status === 400) return "errors.requestRejected";
  if (status === 401) return "errors.sessionExpired";
  if (status === 403) return "errors.unauthorizedAction";
  if (status === 404) return "errors.notFound";
  if (status === 409) return "errors.conflict";
  if (status === 413) return "errors.payloadTooLarge";
  if (status === 429) return "errors.tooManyAttempts";
  if (status === 503) return "errors.serviceUnavailable";
  if (status >= 500) return "errors.internalError";
  return null;
}

/**
 * Resolve the message key for a failed response. `fallback` covers callers
 * whose failure has a more specific meaning than the status alone conveys —
 * a failed sign-in should not claim the session expired.
 */
export function apiMessageKey(
  code: string | undefined,
  status: number,
  fallback: MessageKey = "errors.operationFailed",
): MessageKey {
  if (code && code in CODE_KEYS) return CODE_KEYS[code];
  return statusMessageKey(status) ?? fallback;
}
