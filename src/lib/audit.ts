import { db } from "../db";
import { auditEvents } from "../db/schema";
import { nanoid } from "./nanoid";

export type AuditActor = "user" | "odoo" | "agent" | "desktop" | "system" | "platform";

const SECRET_KEYS = /password|secret|token|authorization|cookie|api[_-]?key|payload|pairing/i;
const MAX_AUDIT_BYTES = 32 * 1024;
const MAX_AUDIT_DEPTH = 6;
const MAX_AUDIT_NODES = 1000;
const MAX_AUDIT_COLLECTION_ITEMS = 100;
const MAX_AUDIT_STRING_LENGTH = 500;

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  let nodes = 0;

  const sanitize = (entry: unknown, depth: number): unknown => {
    if (depth > MAX_AUDIT_DEPTH) return "[depth-limit]";
    nodes += 1;
    if (nodes > MAX_AUDIT_NODES) return "[node-limit]";

    if (typeof entry === "string") {
      return entry.length > MAX_AUDIT_STRING_LENGTH
        ? `${entry.slice(0, 200)}…(${entry.length} chars)`
        : entry;
    }
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) {
      return entry.slice(0, MAX_AUDIT_COLLECTION_ITEMS).map((item) => sanitize(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry)) {
      if (SECRET_KEYS.test(key)) {
        out[key] = "[redacted]";
      } else if (child !== undefined) {
        out[key] = sanitize(child, depth + 1);
      }
      if (Object.keys(out).length >= MAX_AUDIT_COLLECTION_ITEMS) break;
    }
    return out;
  };

  let sanitized = sanitize(value, 0) as Record<string, unknown>;
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_AUDIT_BYTES) {
      sanitized = { _truncated: "audit metadata exceeded 32KiB after sanitization" };
    }
  } catch {
    sanitized = { _truncated: "audit metadata could not be serialized safely" };
  }
  return sanitized;
}

export async function writeAuditEvent(
  input: {
    tenantId: string | null;
    actorType: AuditActor;
    actorId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  },
  runner: { insert: typeof db.insert } = db
): Promise<void> {
  await runner.insert(auditEvents).values({
    id: `audit_${nanoid(14)}`,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    requestId: input.requestId ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}
