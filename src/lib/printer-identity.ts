import { createHash } from "node:crypto";

/**
 * Agent-scoped identity for colliding local discovery IDs.
 *
 * Keep this helper outside the Next.js route module: App Router route files
 * may only export supported route fields/handlers, while unit tests still need
 * a direct deterministic identity primitive.
 */
export function aliasPrinterIdForAgent(localId: string, agentId: string): string {
  const suffix = createHash("sha256")
    .update(`printer-alias:${agentId}:${localId}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${localId}~${suffix}`;
}
