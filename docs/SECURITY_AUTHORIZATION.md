# Function and data authorization rules

## Authority model

This document defines who may invoke application functions and which resource attributes constrain the data they can use. It addresses the documentation requirement in ASVS V8.1.1. Permission names are server policy, not merely UI visibility. A syntactically valid resource ID, authenticated connection, successful discovery, or printed role label does not grant access.

The application has separate human platform, human workspace, paired machine, Odoo integration and local desktop authorities. Do not translate a credential from one audience into another. In particular, a workspace `owner` is not a platform administrator; Odoo `base.group_system` is an Odoo application role, not Gateway platform authority. Related input-format rules are in `SECURITY_INPUT_VALIDATION.md`; communication boundaries are in `SECURITY_COMMUNICATIONS.md`.

## Consumers and trust boundaries

| Consumer | Permitted functions and admitted identity | Data boundary / denial rule | Source |
| --- | --- | --- | --- |
| Unauthenticated visitor | Account registration, password/email flows, sign-in, invitation preview/acceptance prerequisites, limited health/probe endpoints. Pending proofs expose only their defined continuation. | A correct password for a verified account issues its scoped session after current authority is checked. Email verification/setup does not grant workspace/platform authority. Authentication/verification rate limits remain separate from resource permissions. | `src/app/api/auth/login/route.ts`; `src/app/api/auth/verify-email/route.ts`; `src/app/api/health/route.ts`; `src/app/api/agent/probe/route.ts` |
| Workspace human | Current `customer` or database-backed `manager` session, verified account, durable password-session policy and live selected-tenant membership with the exact role in the session. | Every operation is constrained by the selected tenant, role permission, session policy and relevant resource relationships. A platform cookie is not a workspace fallback. | `src/lib/manager-auth.ts:109`; `src/lib/customer-auth.ts`; `src/lib/workspace-session-security.ts:44` |
| Platform owner | Dedicated `platform` session; current `users.is_platform_owner`, verified email, exact account/email and live platform password/session state. | May use the explicit cross-tenant control-plane surface. Workspace membership or role cannot establish this audience. Privileged mutations also require fresh password confirmation at transaction commit. | `src/lib/platform-auth.ts:75`; `src/lib/platform-session-security.ts` |
| Paired Agent | Credential for one registered active Agent in one active tenant; machine APIs for its inventory/discovery/desired state, polling and reports; outbound WebSocket delivery for that Agent. | Tenant and Agent come from the verified credential. Job updates/ACKs additionally need current job/claim ownership. It receives no human role, account inventory or control-plane permission. | `src/lib/agent-auth.ts`; `src/app/api/agent/heartbeat/route.ts:270`; `src/app/api/agent/jobs/route.ts`; `src/server/ws.ts` |
| Odoo installation | Live API key for one tenant; for v2 operations, enrolled installation with proof and current credential association. | Credential, installation, company/operation namespace, tenant lifecycle and shared-printer admission all constrain access. `X-Odoo-Database` is informational, not authority. Rotation-grace keys are read-only. | `src/lib/odoo-auth.ts:28`; `src/lib/odoo-v2-admission.ts`; `src/lib/odoo-status-scope.ts` |
| Odoo application user/admin | Authenticated Odoo session, Odoo model ACLs and allowed company/branch rules. | Source-record read access and company/branch relationships must be checked before trusted private dispatch. Odoo administrators cannot choose an unassigned branch Agent merely because it belongs to the Gateway tenant. | `odoo_addons/print_gateway/security/ir.model.access.csv`; `odoo_addons/print_gateway/security/security.xml`; `odoo_addons/print_gateway/controllers/runtime_printers.py:13` |
| Metrics collector | Optional independent credential admitted only to a literal read-only `GET /api/metrics` without query parameters. | No workspace, platform mutation or other API permission. Explicit malformed authorization cannot fall back to an ambient owner cookie. The separate legitimate platform-owner path remains available. | `src/lib/metrics-machine-auth.ts:78`; `src/app/api/metrics/route.ts:8` |
| Local desktop operator | Capabilities exposed to the local Tauri main window and local OS/service permissions. Gateway requests use the paired Agent CLI; privileged secrets are not supplied by WebView JavaScript. | Allowed native commands and API-relative operation allowlist are not a Manager login or an arbitrary shell/HTTP proxy. Service/elevation and file/credential ACLs remain OS boundaries. | `src-tauri/capabilities/default.json`; `src-tauri/src/commands.rs:699`; `src/desktop/lib/ipc.ts` |

Environment-configured managers without durable accounts are explicitly limited to the supported development/test compatibility path. Production session issuance/admission rejects the unsupported environment-manager shortcut; never invent a user or password-verification proof for an old/v1/no-state token. Paired Agent identities are unaffected by this human cutover (`src/lib/session-credentials.ts:15`; `MIGRATION.md`).

## Workspace operational permission policy (single Full Access)

All authenticated, currently enrolled workspace members receive **one** fixed
operational access level. Historical `owner` in the membership table records
ownership for transfer/integrity only; it is **not** a privileged workspace
role. New invitations always create `admin` memberships; older limited
roles are migrated to `admin` by forward migration 0096.

| Function permissions | Workspace member |
| --- | --- |
| `tenant.read`, `tenant.update`, `users.read` | Allow |
| `agents.read`, `agents.pair`, `agents.disable`, `agents.retire` | Allow |
| `printers.read`, `printers.manage`, `printers.test` | Allow |
| `jobs.read`, `jobs.payload.read`, `jobs.create`, `jobs.retry`, `jobs.cancel` | Allow |
| `bindings.read`, `bindings.manage` | Allow |
| `integrations.read`, `integrations.manage` | Allow |
| `users.manage` | **Deny** |
| `billing.read` | **Allow only the workspace `owner` membership**, scoped to its tenant; no activation authority |
| `billing.manage` | **Deny** |

Only the separately verified `platform` session audience with fresh Platform
Owner password proof may approve/activate subscriptions, set plan limits,
change ownership and perform cross-tenant administrative writes. A verified
Platform Owner can create/revoke invitations for the *selected workspace* via
`/api/team/invitations` using that workspace's own current session; the
Platform Admin invitation endpoint has been retired. The workspace `owner`
can read its own `/billing` data and submit a manual activation/renewal request,
but cannot grant itself service, change limits or authorize payments. Other
workspace roles retain operational Full Access without private billing reads.

**Compatibility note:** 0096 removes old *assignable values* but deliberately
keeps the database `role` column and the internal `owner` marker while the
existing signed-token/session and referential integrity architecture remains
in service. This is a staged retirement, not a completed role-column deletion.
Do not claim full schema removal without a separately verified role-free
cutover and populated database restore test.

## Session and commit-time conditions

For a workspace request, verify the token's signature, audience/kind, tenant and time, then current durable authority. A usable v2 family has an exact live refresh SID, matching tenant/user/kind/role, current password-verifier snapshot. Tenant lifecycle must be `active`; current membership must still match the claimed role. Missing state, changed membership, password reset, revoked SID/family, future authority timestamps or expired state fail closed. Background reads/probes/refresh do not recreate activity or fresh proof (`src/lib/manager-auth.ts:109`; `src/lib/workspace-session-security.ts:44`).

Workspace idle expiry is thirty minutes and the family's original absolute lifetime is thirty days. Platform idle expiry is thirty minutes with an eight-hour absolute lifetime. A session can be generally usable while its privileged confirmation has become stale. The following workspace permissions require the password verified within five minutes:

`tenant.update`, `users.manage`, `agents.pair`, `agents.disable`, `agents.retire`, `printers.manage`, `jobs.retry`, `jobs.cancel`, `bindings.manage`, `integrations.manage`, `billing.manage`.

Normal reads, ordinary `jobs.create` and observation/diagnostic `printers.test` do not acquire the five-minute requirement merely by being POST requests. They still require their exact permission and a live idle-safe session. Do not generalize this exception to configuration changes or a deliberate reprint of an existing physical job (`src/lib/workspace-session-security.ts:37`; `src/app/api/jobs/[id]/reprint/route.ts`; `src/app/api/printers/[id]/test-print/route.ts`).

Mutation admission is repeated inside the database transaction after relevant resource locks and the active-tenant fence. `requireManagerActorInTransaction` locks current user/family authority and checks the exact permission, membership and SID; team mutations require the separate Platform Owner APIs; the retired workspace-team guard fails closed. A stale preflight decision cannot authorize a write queued behind a logout, password reset, role change, tenant suspension. Platform writes use their separate `requirePlatformActorInTransaction` and fresh platform password checks. Do not replace a transactional guard with a successful UI or initial route check (`src/lib/manager-mutation-authorization.ts:26`; `src/lib/team-authorization.ts`; `src/lib/platform-auth.ts:75`).

Workspace stale confirmation returns HTTP 403 with `WORKSPACE_REAUTHENTICATION_REQUIRED`, `X-Yaseir-Reauthentication: required` and `/settings?reauth=1`. Expired/invalid session authority is HTTP 401. Confirm Identity requires the user's actual password, rotates the current pair and preserves the family deadline. It does not replay a previously rejected mutation. Platform-target operations use the separate `/platform/security` flow. Infrastructure failures must not mint authority or silently masquerade as completed revocation (`src/lib/workspace-session-http.ts`; `src/components/WorkspaceSecurity.tsx`; `src/lib/session-tokens.ts`).

## Resource and data rules

| Resource/function family | Required permission or authority | Resource attributes and additional restrictions | Source |
| --- | --- | --- | --- |
| Workspace settings/onboarding | `tenant.read` / `tenant.update`; retired onboarding denies workspace tokens | Tenant is the session's selected tenant. Every live workspace member has the same settings permission and commit-time password proof requirement. A caller-supplied tenant ID does not replace session scope; commercial changes require dedicated Platform Owner authority. | `src/app/api/settings/route.ts`; `src/app/api/onboarding/route.ts` |
| Team listing/invitation/role removal | `users.read` or `users.manage` as appropriate; durable user required for mutation | Membership/invitation belongs to the current tenant. Only verified Platform Owner workspace sessions may create/revoke invitations in their tenant. Workspace member-role/deletion/ownership mutations still deny ordinary workspace tokens; the internal owner marker remains protected. | `src/app/api/team/members/route.ts`; `src/app/api/team/invitations/route.ts`; `src/lib/team-authorization.ts` |
| Ownership transfer | Fresh Platform Owner session and a same-tenant member target | Target is an existing same-tenant member distinct from the current owner. Lock tenant and memberships; demote current owner and promote target atomically; revoke both affected authorities. A concurrent role change cannot silently transfer ownership. Workspace transfer endpoints deny workspace tokens. | `src/app/api/platform/tenants/[id]/ownership/route.ts`; `src/app/api/team/ownership/route.ts` |
| Invitation acceptance / tenant switch | Proof for the existing account or the restricted mailbox/password onboarding flow; live target membership/invitation | Invitation email binds the recipient and role; optional client context grants nothing. Existing-session acceptance/switch carries original password proof and earliest deadline, atomically rechecks source authority, and cannot create freshness from the database's password hash. | `src/app/api/team/invitations/accept/route.ts:144`; `src/app/api/auth/select-tenant/route.ts`; `src/lib/session-tokens.ts` |
| Agent inventory/pairing/lifecycle | `agents.read`, `agents.pair`, `agents.disable`, `agents.retire` | All human lookups/mutations constrain Agent tenant. Pairing consumes an exact live pending code for that Agent and tenant; it does not convert an arbitrary requested Agent ID into ownership. Lifecycle changes recheck tenant, actor and expected resource state. | `src/lib/agent-control.ts`; `src/lib/agent-lifecycle.ts`; `src/app/api/agents/route.ts`; `src/app/api/agent/register/route.ts` |
| Discovery and provision | Read Agent/discovery state with the relevant read permission; `agents.pair` to start discovery; `printers.manage` to verify/provision | Session/device IDs belong to the current tenant and selected Agent. Reported candidate identity, observed address, verified transport and snapshot revision must still agree at commit. Discovery itself does not enroll a different tenant's device or make a private printer shared. | `src/app/api/agents/[id]/discovery/route.ts`; `src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts`; `src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts` |
| Printer read/config/lifecycle | `printers.read`, `printers.manage` | Printer and associated Agent belong to the tenant. Configured destination/protocol and source of management must agree; lifecycle and desired/observed revisions are commit conditions. Agent-local sharing consent is not silently inferred from cloud existence. | `src/app/api/printers/route.ts`; `src/app/api/printers/[id]/route.ts`; `src/app/actions.ts:192`; `contracts/printer-sharing-contract.json` |
| Printer diagnostics / deliberate reprint | `printers.test` for supported diagnostic function; explicit existing-job reprint requires `jobs.retry` | Same-tenant target and valid capability. A paired Agent may request the supported test-print diagnostic only for its own printer using a mandatory scoped idempotency key; it gains no workspace-wide role. Reprint also evaluates the original outcome and requires explicit operator action. A transport ACK/unknown outcome is not authority to retry automatically on another printer. | `src/app/api/printers/[id]/test-connection/route.ts`; `src/app/api/printers/[id]/test-print/route.ts`; `src/app/api/jobs/[id]/reprint/route.ts`; `src/lib/job-status.ts` |
| Human job list/detail/payload/create/cancel | `jobs.read`, separately `jobs.payload.read`, `jobs.create`, `jobs.cancel` | Scope every query/write to tenant and the target printer/Agent relationships. Creation checks live subscription, quota, resource lifecycle, current explicit sharing and capability. Service callers carry current manager authority into the enqueue transaction. | `src/app/api/jobs/route.ts`; `src/app/api/jobs/[id]/route.ts`; `src/lib/print-job-service.ts:124`; `src/lib/entitlements.ts` |
| Odoo credential/installations/cutover | `integrations.read` / `integrations.manage` on human routes; machine auto-enrollment uses its own live API key | API key, installation and namespace all belong to the selected tenant. Credential rotation's read-only grace cannot submit/configure. Human key management/manual enrollment uses workspace permission; enrollment creates the installation proof. The proof is a further requirement for v2 machine admission/status, not a prerequisite to create an installation. Collision resolution binds the expected legacy job/fingerprint and explicit operator attestation. | `src/app/api/odoo/keys/route.ts`; `src/app/api/odoo/keys/[id]/rotate/route.ts`; `src/app/api/odoo/installations/route.ts`; `src/app/api/odoo/installations/resolutions/route.ts` |
| Odoo machine print/status/configuration | Current Odoo key and, where required, installation proof | Tenant lifecycle and integration activation are separate. Health/configuration may authenticate while disabled to report state or re-enable; new printing requires enabled non-grace authority. Status reads are metadata only and bind tenant plus installation provenance; legacy headers cannot downgrade a v2-owned job. | `src/lib/odoo-auth.ts:28`; `src/lib/odoo-status-scope.ts`; `src/app/api/odoo/configuration/route.ts`; `src/app/api/print/jobs/v2/route.ts` |
| Billing | Workspace `owner`: `billing.read`/request only; Platform Owner: grant/activate/change | Public catalog and status are available without a commercial grant. Only the tenant's own workspace `owner` reads commercial quota and submits an idempotent request; a request never activates service. Retired provider routes return 410. Platform mutations bind actor, workspace, current revision, idempotency key and immutable history. | `src/app/api/billing/status/route.ts`; `src/app/api/platform/tenants/[id]/subscription/route.ts`; `src/lib/manual-subscriptions.ts` |
| Account sessions | Current durable account; fresh password for workspace revocation; fresh platform password for platform-target changes | Both inventory endpoints list only the account's **own live** families across customer/manager/platform and all its workspaces. Filter live tenant/membership/credential policy before pagination. A workspace password cannot revoke a platform family without separate current platform proof. No other user's session is listed/revoked, even if the actor is an owner. | `src/lib/session-inventory.ts:54`; `src/app/api/auth/sessions/route.ts`; `src/app/api/platform/auth/sessions/route.ts` |
| Platform fleet/tenant/integration/plan administration | Dedicated current platform owner; fresh platform proof at mutation | Explicit cross-tenant routes select the requested resource plus its tenant, recheck current lifecycle/expected state and use resource locks/audit. Platform database exploration uses an allowlisted projection; owner access is not arbitrary SQL or secret-column export. | `src/app/api/platform/fleet/lifecycle/route.ts`; `src/app/api/platform/tenants/[id]/delete/route.ts`; `src/app/api/platform/plans/route.ts`; `src/app/api/platform/database/route.ts`; `src/lib/platform-data-explorer.ts` |

An active tenant is a prerequisite for normal workspace/machine operations. Suspended, deleted, absent or unknown lifecycle is denied. Subscription restrictions are additional commercial/resource admission rules, not a replacement for tenant isolation: new admission requires manual status `active`, an unblocked record, a start at or before the authoritative database clock and either no end or an end strictly in the future. The subscription row is locked before evaluating time-sensitive eligibility after any wait. Pending, expired, suspended or blocked state cannot admit work; historical authorized results remain readable without creating another print (`src/lib/tenant-guard.ts`; `src/lib/entitlements.ts`).

## Odoo model and company rules

Odoo's model ACLs are distinct from the Gateway role matrix. `base.group_user` has read-only access to Gateway configuration, bindings, print jobs, policies and intents. `base.group_system` has read/write/create on those models; configuration, assignments, bindings, pairing wizard and policy can be deleted, while print-job and intent ACLs do not grant unlink. Runtime assignments and pairing wizard are not exposed through the ordinary-user ACL. These exact model permissions are declared in `odoo_addons/print_gateway/security/ir.model.access.csv`.

Record rules then constrain the data. A configuration can be read when its `company_id` is in the allowed-company set or one of that company's direct `child_ids` is in the set. This permits an allowed branch to read its root configuration; it does not invert the rule to make every child configuration readable from an allowed root. Writing a root configuration requires its own `company_id` in the allowed-company set. Binding read scope includes the permitted branch/root hierarchy; writes require the permitted branch or permitted root when no branch is set. Runtime assignments and policies are scoped to the allowed branch/root. Job and intent visibility includes records owned by an activated company or its direct children so a root operator can reconcile its branches' activity; it does not include a different root's branches. The rule definitions and operation-specific flags are in `odoo_addons/print_gateway/security/security.xml`.

Trusted dispatch is private server code, not general model-create permission for ordinary users. `create_operation` is `@api.private`, requires the active company, and requires the Gateway configuration to belong to that company's root/parent relationship before creating the outbox under its internal elevation. Report producers also check source-record read access. Runtime discovery controllers require an authenticated Odoo system administrator, an allowed company/branch and the exact branch-to-Agent assignment. Internal `sudo` is used for those defined service operations; it must not be treated as a rule that any caller may select any company/configuration/printer (`odoo_addons/print_gateway/models/print_job.py:502`; `odoo_addons/print_gateway/models/ir_actions_report.py:44`; `odoo_addons/print_gateway/models/runtime_assignment.py:104`; `odoo_addons/print_gateway/controllers/runtime_printers.py:13`).

## Data minimization and storage boundaries

Tenant/resource identifiers are carried in database predicates and schema relationships as well as request authentication. `src/db/schema.ts` and its immutable migrations define the relevant composite ownership foreign keys/uniqueness and state checks. These constraints support the per-resource rules; they do not infer function permission from the presence of a row. Status/list projections exclude payloads and credentials unless the specific function permits them. Access/refresh credentials remain HttpOnly cookie values rather than renderer-readable JSON; status responses explicitly whitelist public fields.

The Gateway runtime database role has DML needed by application functions, without migration ownership, role administration, general DDL or migration-ledger authority. Operators use separate bootstrap/migration roles; application platform-owner status does not grant PostgreSQL superuser or host administration. Backup, key rotation and host service control are separate maintenance/OS authorities documented in `docs/DATABASE_ROLES.md` and `docs/WINDOWS_SERVICE_RECOVERY.md`.

## Reviewing and extending this policy

For a new function, identify the consumer/audience, exact permission, tenant/account scope, resource relationships, lifecycle/precondition and whether fresh confirmation is required. For a write, place the live authority check after the necessary resource lock and before mutation/commit. For a service/server action, carry the actor's real authority to that boundary; do not manufacture a grant or assume a route already checked it. Browser hiding, static role labels and lexical presence of a guard name are not proof of enforcement.

Review the central matrix against `src/lib/authorization.ts` and the fresh-permission set against `src/lib/workspace-session-security.ts`. Trace HTTP entry points, `src/app/actions.ts`, shared enqueue/lifecycle services, Agent WebSocket handlers and Odoo controllers/private dispatch. Verify object queries use the appropriate authenticated tenant/account/Agent/installation relation, not only a caller-provided ID. When changing a relationship, select existing positive/negative role, cross-tenant, cross-user, audience and logout/reset/lifecycle-race cases from the repository's test groups. Relevant suites include `tests/tenant-isolation.test.ts`, `tests/tenant-isolation-extended.integration.test.ts`, `tests/control-plane-concurrency.integration.test.ts`, `tests/platform-mutation-authorization.test.ts`, `tests/password-only-auth.integration.test.ts`, `tests/odoo-status-concurrency.integration.test.ts` and `odoo_addons/print_gateway/tests/test_durable_identity_security.py`.

## Bounded denial events

The supported custom server observes completed HTTP 401, 403, 405 and 429
responses, including early Origin refusals and application authorization
responses. An untrusted-proxy refusal and WebSocket handshake refusals use the
same `security.access.denied` event. Central Manager permission denials add the
checked permission, role and bounded identifiers from verified claims. The HTTP
observer records each response once across its `finish` and `close` events.

`src/server/authorization-monitor.ts` accepts a fixed schema with no request,
URL, query string, body, header, email, session or caller-supplied correlation
value. These security events remain enabled at every ordinary `LOG_LEVEL`.
Separately bundled route modules share one process-wide budget: the first 120
events per minute retain detail; excess events contribute to at most 15 fixed
surface/status counters. The minute timer and graceful shutdown flush those
counters. Manager and HTTP events describe different decision boundaries, so
their counts must not be summed as unique requests.

The output is an operational stream, not a separate tamper-resistant audit
store. Aggregates can be lost on an abrupt process/host failure, and a broken
sink cannot change an authorization refusal into success. A deployment still
needs protected collection, monitored ingestion and an inventory covering
upstream Odoo, native authorization and Level 3 successful/sensitive accesses.
These software checks do not establish full-product ASVS logging conformance.

This document defines the policy to review. It does not certify every path's implementation, all future changes, a deployed environment or native Windows execution. Those enforcement and release requirements have their own acceptance evidence and must retain their own result.
