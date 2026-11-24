import { applicationOrigin } from "./application-origin";
import { ManualSubscriptionError } from "./manual-subscriptions";

/** Platform team mutations require an exact first-party origin, not a Host-derived origin. */
export function assertPlatformTeamOrigin(req: Request): void {
  if (req.headers.get("origin") !== applicationOrigin() || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ManualSubscriptionError("INVALID_ORIGIN", 403);
  }
}
