/** Int64 versions travel as decimal strings so JavaScript never rounds them. */
export function parseInventorySnapshotVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  return BigInt(value) <= 9223372036854775807n ? value : null;
}

/** Validate under the Agent row lock, before presence or metadata writes. */
export function inventoryVersionAllowsPage(
  version: string | null,
  retainedVersion: string,
  page: number,
): boolean {
  // Old clients may contribute observations until a versioned writer takes
  // ownership. They never authorize absence, and cannot downgrade that fence.
  if (version === null) return retainedVersion === "0";
  if (!parseInventorySnapshotVersion(version)) return false;
  if (retainedVersion !== "0" && !parseInventorySnapshotVersion(retainedVersion)) return false;
  return page === 1
    ? BigInt(version) > BigInt(retainedVersion)
    : version === retainedVersion;
}
