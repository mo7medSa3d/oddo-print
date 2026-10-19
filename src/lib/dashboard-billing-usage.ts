/** Read dashboard quota data only after the subscription-status preflight.
 *
 * A missing/expired plan is normal for an onboarding workspace: status returns
 * 200 with hasSubscription=false while the guarded /api/billing/usage endpoint
 * correctly returns 403. This client policy prevents those predictable 403s
 * without changing the API's RBAC or entitlement checks.
 */
export type DashboardBillingUsageResult<T> =
  | { kind: "available"; usage: T }
  | { kind: "unsubscribed" }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

export async function fetchDashboardBillingUsage<T>(
  request: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<DashboardBillingUsageResult<T>> {
  const init: RequestInit = { credentials: "same-origin", cache: "no-store", signal };
  const status = await request("/api/billing/status", init);
  if (status.status === 401 || status.status === 403) return { kind: "forbidden" };
  if (!status.ok) return { kind: "unavailable" };

  const summary = await status.json().catch(() => null) as unknown;
  if (!summary || typeof summary !== "object" || Array.isArray(summary) ||
      typeof (summary as { hasSubscription?: unknown }).hasSubscription !== "boolean") {
    return { kind: "unavailable" };
  }
  if (!(summary as { hasSubscription: boolean }).hasSubscription) return { kind: "unsubscribed" };

  const usageResponse = await request("/api/billing/usage", init);
  if (usageResponse.status === 401 || usageResponse.status === 403) return { kind: "forbidden" };
  if (!usageResponse.ok) return { kind: "unavailable" };

  const usage = await usageResponse.json().catch(() => null) as unknown;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) ||
      !("resources" in usage) || !usage.resources || typeof usage.resources !== "object" ||
      !("prints" in usage.resources) || !usage.resources.prints) {
    return { kind: "unavailable" };
  }
  return { kind: "available", usage: usage as T };
}
