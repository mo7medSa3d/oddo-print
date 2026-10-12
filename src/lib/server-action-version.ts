/**
 * Client-only presentation of a Next.js deployment-version mismatch.
 * Stale tabs can invoke an action ID from a previous build. That exception
 * must not expose the action ID or trigger an automatic mutation retry.
 */
export function isServerActionVersionMismatch(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:Failed to find Server Action|Server Action[^\n]{0,100}was not found on the server|failed-to-find-server-action|request might be from an older or newer deployment)/i.test(text);
}
