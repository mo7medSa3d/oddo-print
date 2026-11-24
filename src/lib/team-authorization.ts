import type { DbTx } from "../db";
import type { ManagerClaims } from "./manager-auth";
import { workspacePolicyResponse, type WorkspacePolicyError } from "./workspace-session-security";

export class TeamAuthorizationChangedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(readonly policy?: WorkspacePolicyError) {
    super(policy?.message ?? "Workspace team mutations are now restricted to Platform Owner.");
    this.name = "TeamAuthorizationChangedError";
    this.code = policy?.code ?? "WORKSPACE_AUTHORITY_CHANGED";
    this.status = policy?.status ?? 403;
  }
  response(): Response {
    return this.policy ? workspacePolicyResponse(this.policy) :
      Response.json({ error: this.message, code: this.code }, { status: 403 });
  }
}

/** Fail closed for any forgotten caller of the obsolete workspace-owner gate.
 * Only the separate Platform Owner audience has team write APIs. */
export async function requireTeamActorInTransaction(
  _tx: DbTx, _claims: ManagerClaims, _relatedUserIds: string[] = [],
): Promise<void> {
  throw new TeamAuthorizationChangedError();
}

/** Standard 403 response for workspace team/ownership mutation routes reserved for Platform Owner. */
export function platformOwnerRequiredResponse(): Response {
  return Response.json({ error: "Platform Owner required", code: "PLATFORM_OWNER_REQUIRED" }, { status: 403 });
}
