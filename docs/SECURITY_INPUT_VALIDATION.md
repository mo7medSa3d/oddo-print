# Input validation rules

## Scope and interpretation

This document defines the structures and semantic rules used to admit application data. It covers browser and integration requests, paired Agent reports, printer configuration, and the shared print contract. It addresses the documentation requirement in ASVS V2.1.1. Authorization to use a valid identifier is a separate check; the rules in `SECURITY_AUTHORIZATION.md` apply after structural validation. Configurable network locations are also covered in `SECURITY_COMMUNICATIONS.md`.

Unless a limit explicitly says **bytes** or **Unicode code points**, TypeScript string lengths and Zod string limits count JavaScript UTF-16 code units. A range written `1–120` includes both endpoints. `optional` permits an omitted field; it does not automatically permit JSON `null`. Numeric fields are JSON numbers unless a particular query parser explicitly coerces text. Do not trim passwords or silently apply display-name normalization to identifiers, secrets, hashes, payloads or signed values.

There is no universal “every object is strict” contract. A Zod `.strict()` object rejects unknown properties; a normal `z.object` strips unknown properties from its parsed result; `.passthrough()` retains them. Manual parsers select their documented fields. Do not infer permission to persist arbitrary input from an extensible metadata object. The schema appendix records these differences explicitly. It lists declared schemas; manual validation and downstream semantic checks are documented in the rule tables.

## Request envelopes and resource limits

| Boundary | Required structure and bound | Source |
| --- | --- | --- |
| HTTP method | The custom server admits only `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`; other methods receive 405 before routing, without echoing request data. This does not authorize the requested action. | `src/server/request-guard.ts` |
| HTTP body length | If `Content-Length` is present it must be a single unsigned decimal safe integer. Invalid declared length is rejected. Absence of the header does not prove an empty or bounded body. | `src/lib/request-limits.ts:1` |
| Gateway API stream | Custom-server default ceiling is 8 MiB. Admission reserves separate concurrent body budgets: 32 MiB for signature-classified traffic and 8 MiB for unauthenticated traffic. This preliminary classification is a resource-budget decision, not route authorization. The custom server measures chunked traffic; a route's declared-length check alone does not. | `src/server/request-guard.ts:8` |
| Smaller machine/security routes | Registration 64 KiB; heartbeat 512 KiB; discovery 2 MiB; Agent status 64 KiB; CSP reporting 16 KiB; browser security routes retain the custom-server streaming boundary. Routes repeat their own limits. | `src/server/request-guard.ts` |
| CSP telemetry | `application/csp-report`, absent/identity content encoding, valid UTF-8 JSON object with an object-valued `csp-report`. Only an allowlisted `effective-directive`, disposition `enforce/report`, and integer `status-code` 0 or 100–599 are retained. Other metadata is ignored, including URLs, tokens, samples and policy text. The stream has a 16 KiB ceiling and two-second deadline; process-wide limits are eight concurrent reads and 60 attempts per 60 seconds. Reports grant no authority and retain the ordinary cookie/Origin guard. | `src/lib/csp-report.ts`; `src/app/api/security/csp-report/route.ts` |
| Workspace security JSON | Stream and accumulate at most 32 KiB before JSON parsing; reject missing/invalid JSON. Password reauthentication parses strict objects afterwards. | `src/lib/workspace-session-http.ts:31`; `src/app/api/auth/reauth/password/route.ts` |
| Ordinary structured POST/PATCH bodies | JSON object, not an array or scalar, where the manual parser requires an object; route-specific Zod schema elsewhere. Invalid syntax is a client error and must not reach mutation code. Typical small account/team/settings routes have declared limits of 32 or 64 KiB. | `src/app/api/auth/register/route.ts:20`; `src/app/api/settings/route.ts:24`; `src/app/api/team/invitations/route.ts:76` |
| WebSocket Agent messages | Inbound messages are bounded to 64 KiB. Parse JSON; process only the supported `job_ack` message shape; acknowledgment authority includes the exact job/Agent/tenant/claim. Separate limits bound sockets, concurrent message handling and buffered output. | `src/server/ws.ts:38`; `src/server/ws.ts:695` |

The edge/custom-server/route limits are complementary. An alternate hosting entry point must preserve the streaming limit; merely retaining `hasBodyOverLimit` does not validate an unbounded chunked stream. See `docs/CONTAINER_RUNTIME.md` for the supported process/proxy deployment.

## Account, authentication and session inputs

| Data item | Validation rule | Source |
| --- | --- | --- |
| Email | Trim surrounding whitespace and lowercase before account lookup. Maximum 320 code units; match `^[^\s@]+@[^\s@]+\.[^\s@]+$`. This is the implemented basic address structure, not a claim to implement every RFC mailbox form. Mailbox ownership requires the separate verification flow. | `src/lib/password.ts`; `src/app/api/auth/register/route.ts:23` |
| New password | Exact string, at least 12 Unicode code points and at most 4096 UTF-16 code units. Mailbox-owner password setup, reset and bootstrap reject locally common/contextual and provider-confirmed breached values; registration accepts name/email only and stores a random provisional verifier; a failed required screening lookup does not admit a new password. Existing-password verification accepts 1–4096 to support existing credentials. Whitespace is significant. | `src/lib/new-password-policy.ts`; `src/lib/password.ts`; `src/lib/password-screening.ts`; `security/PASSWORD_SCREENING.md` |
| Email verification/reset/setup proof | Issuers create 32 random bytes encoded as base64url; the database stores the hash. Verification input is a nonempty string of at most 256 code units. Reset accepts a nonempty string within the bounded request; it is not a general user identifier. Both require a matching unconsumed hash and database-clock validity: creation is not in the future, age is strictly below ten minutes, and the stored expiry has not passed. A shorter stored expiry wins, including outstanding links issued under older policies. | `src/lib/password.ts`; `src/lib/email-auth-token-policy.ts`; `src/app/api/auth/verify-email/route.ts:20`; `src/app/api/auth/reset-password/route.ts:18` |
| Tenant selection | A dedicated signed `tenant_selection` token binds account, email and credential version for five minutes. It is not an access token. Verification checks the token structure/signature/time and the destination's live membership; switching an authenticated session carries existing proof and expiry. | `src/lib/customer-auth.ts:40`; `src/app/api/auth/select-tenant/route.ts` |
| Security origin configuration | `APP_BASE_URL` must be a clean HTTPS origin without username/password/query/fragment or a non-root path. HTTP is allowed only on enumerated loopback names outside production. Origin comparison is exact. | `src/lib/application-origin.ts` |
| Session mutation | Strict action `revoke`, `revoke_others` or `revoke_all`. Workspace confirmation password is an exact nonempty string ≤4096. Platform target family uses 32 lowercase hex characters; the inventory service additionally validates supported legacy identifiers. The server derives the account and available target scope. | `src/app/api/auth/sessions/route.ts:19`; `src/app/api/platform/auth/sessions/route.ts:11`; `src/lib/session-inventory.ts:130` |
| Signed session pagination | Cursor ≤512 characters; base64url body plus a canonical 43-character base64url signature. Decoded object has exactly keys `i,t,v`, version 1, decimal time string of 1–20 digits and a 32-character lowercase hex family ID. HMAC verification is bound to the account. A valid-looking unsigned cursor is rejected. | `src/lib/session-inventory.ts:32` |

Email verification/setup, password login, tenant selection and current-session password confirmation are distinct proof types. Valid syntax cannot substitute one for another. Ten-minute mail-proof expiry does not change invitation, session or printer-job lifetimes.

## Print submission and installation identity

The canonical cross-component contract is `contracts/print-payload-contract.json`. Its decoded payload maximum is **5,242,880 bytes (5 MiB)**. Gateway, Agent and Odoo must agree on the protocol/type pairing before dispatch; discovering a device or storing a protocol string is not proof that it can execute that format.

| Item | Rule | Source |
| --- | --- | --- |
| Submission envelope | Strict object; trimmed `printerId` and `documentType` 1–120; optional trimmed destination 1–255; `payload` delegated to the shared validator; optional expiry string parsed as a date; idempotency key 1–200 when present. `/api/print/jobs/v2` requires the key. The older route requires it by default in production; the explicitly documented migration override is not a v2 exemption. | `src/app/api/print/jobs/route.ts:34`; `src/app/api/print/jobs/v2/route.ts:21` |
| Payload | `type` one of `raw`, `escpos`, `pdf`, `image`; `encoding` exactly `base64`; nonempty bounded data string. Decode once, reject empty/oversize bytes, and require the canonical base64 round trip. | `src/lib/payload.ts:1`; `contracts/print-payload-contract.json` |
| Payload content | PDF starts `%PDF-` and has `%%EOF` in the last 4096 bytes. Image transport accepts JPEG with `FF D8 FF` leading bytes. RAW/ESC-POS must not contain a PDF masquerading as native command data. These checks do not assert a complete PDF/JPEG parser or safe physical output. | `src/lib/payload.ts:36` |
| Protocol and peripherals | RAW requires one of `raw`, `escpos`, `zpl`, `tspl`; ESC-POS requires `escpos`. PDF/image forbid a protocol field. Peripheral object is strict: drawer `pin2/pin5/none`, cutter `partial/full/none`, buzzer `epson_pulse/star_bel/none`. Active peripheral commands are admitted only with ESC-POS. | `src/lib/payload.ts:7` |
| Image geometry binding | `geometry_fingerprint`, when supplied, is exactly 64 lowercase hexadecimal characters and is allowed only on `image`. It is syntactically optional so accepted historical operations can reconcile their original payload; every **new** image admission requires an exact match to the current validated printer geometry under the printer lock. Missing/stale geometry never becomes an assumed paper width or DPI. | `src/lib/payload.ts`; `src/lib/printer-capability.ts`; `src/lib/print-job-service.ts`; `contracts/printer-geometry-contract.json` |
| Relative job time | A syntactically parseable date is not enough. The service checks requested expiry/future lifetime against the authoritative database clock at admission. Keep date parsing separate from relative-age authority. | `src/lib/print-job-service.ts`; `src/app/api/print/jobs/v2/route.ts:36` |
| Versioned Odoo identity | Version exactly 2; lowercase canonical UUIDv4 installation ID; 43-character base64url proof; positive decimal company ID of 1–18 digits without a leading zero; operation ID 1–200. The supplied idempotency key must equal the SHA-256 of the canonical `['yaseir-odoo-v2', installationId, companyId, operationId]` JSON encoding. The database separately verifies current enrollment and credential ownership. | `src/lib/odoo-idempotency.ts:25`; `src/lib/odoo-v2-admission.ts` |
| Status reconciliation | Batch body is strict, with 1–100 exact, untrimmed job IDs of up to 120 UTF-8 bytes; whitespace normalization, controls and malformed identities are rejected. Namespace headers must be a coherent v2 set; incomplete headers and unsupported versions fail. Legacy status cannot disclose v2-owned jobs simply by omitting headers. Status projections exclude document payloads. | `src/app/api/print/jobs/batch-status/route.ts:16`; `src/lib/odoo-status-scope.ts:46` |
| Lifecycle/reporting | Closed stored job states: `queued`, `claimed`, `printing`, `success`, `failed`, `expired`. Physical outcome is separately `not_printed`, `printed`, `unknown`; transport success is not paper proof. Agent reports must obey the state machine and exact live claim; unknown delivery cannot silently become an automatic retry. Error text is bounded to 2000 and optional claim token to 120. | `src/lib/job-status.ts:1`; `src/app/api/agent/jobs/route.ts:299` |
| Accepted execution binding | A new job stores the current verified `binding_digest` and output medium under the printer lock; the client does not choose either. Claims emit `bindingDigest` and require the admitted digest to match the current verified printer. Missing legacy bindings are ineligible for new execution; they are not silently backfilled. Exact authorized replay/terminal reconciliation reads the original accepted identity before current eligibility and never creates a second operation. | `src/lib/print-job-service.ts`; `src/lib/job-delivery.ts`; `src/app/api/agent/jobs/route.ts`; `contracts/printer-operational-verification-contract.json` |

## Printer configuration and discovery

`src/lib/printer-model.ts` defines the create model and semantic destination checks; `contracts/printer-presentation-contract.json` and `contracts/printer-sharing-contract.json` define the corresponding display/sharing concepts. Create and patch differ in some field bounds. The complete patch declaration is included in the appendix; do not substitute the create schema for a patch.

| Item | Required structure and semantic relationship | Source |
| --- | --- | --- |
| Printer identity/class | Optional ID ≤120 matching `^[a-z0-9_][a-z0-9_-]*$`; Agent ID 1–120; trimmed name 1–100. Printer type is `physical/file`; device class is `thermal/laser/inkjet/label/other/unknown`. Connection is `network/usb/spooler/ipp/ipps/pdf_output`; protocol is `raw/escpos/zpl/tspl/ipp/ipps/spooler/windows_spooler/unknown/pdf`. `unknown` means undeclared and does not establish executable capability. Type `file` is permitted exactly with `pdf_output`, which requires protocol `pdf`; that protocol is rejected on other transports. | `src/lib/printer-model.ts` |
| Config size and scalar fields | Strict config. Ports integer 1–65535; VID/PID 0–65535; IP ≤255, serial ≤255, address ≤512, spooler name ≤255. Create paper widths are finite positive values ≤1000, at most 32. Serialized config ≤16 KiB and capabilities ≤32 KiB. Patch paper-width syntax is separately integer 1–500. | `src/lib/printer-model.ts`; `src/app/api/printers/[id]/route.ts:22` |
| RAW network printer | Literal private/link-local address and port 9100; optional `address` must agree with the IP/port. No public hostnames, loopback or multicast destinations. Specific metadata targets `169.254.169.254`, `169.254.170.2` and numeric forms of `fd00:ec2::254` are forbidden. IPv6 equivalent spellings are compared numerically. | `src/lib/network-address.ts:3`; `src/lib/printer-model.ts` |
| IPP/IPPS | URI or supported explicit host/port form; permitted URI schemes `http/https/ipp/ipps`; no credentials, query or fragment; private/link-local address and allowed port 80/443/631. IPPS requires HTTPS/IPPS. Approved discovered URI must agree with the observed IP, port and transport security. Protocol/connection mismatches are rejected. | `src/lib/printer-model.ts`; `docs/IPP_PRINT_COMPATIBILITY.md` |
| Windows spooler/USB | Spooler needs a nonempty queue name/address. A USB record with a spooler name is normalized to the spooler path. Direct USB needs VID/PID plus the recognized device-interface path form. `windows_spooler` is a supported alias normalized to `spooler`; pass-through declarations are only for spooler. These are format/selection rules, not Windows driver acceptance. | `src/lib/printer-model.ts`; `agent/internal/config/config.go`; `agent/internal/printer/factory.go` |
| PDF output configuration | Strict config accepts only `output_profile_id` and optional `geometry_profile`. The profile ID is 1–64 ASCII letters, digits, `_` or `-`, without surrounding whitespace; it refers to an Agent-local approved profile. Requests cannot provide a directory, filename, network destination or spooler fallback. `output_profile_id` is rejected for other transports. Software/virtual spooler queues remain unsupported; this is the separate explicit file-output backend. | `src/lib/printer-model.ts`; `src/lib/printer-virtual.ts`; `agent/internal/printer/pdf_output.go` |
| Registration and observed capabilities | Registration returns a pending configuration and does not persist caller-supplied capability proof as operational authority. Managers may configure intent, including a validated geometry profile; they cannot attest that a device exists. Authenticated Agent inventory supplies the separate current observation, subject to the exact identity, transport, freshness and convergence rules below. | `src/app/api/printers/route.ts`; `src/app/api/agent/heartbeat/route.ts`; `src/lib/printer-operational-verification.ts` |
| Discovery start | Strict object. Optional private IPv4 CIDR, canonical decimal octets, prefix /16–/30 within 10/8, 172.16/12 or 192.168/16. Protocol list accepts `ipp/ipps/raw/lpr/mdns/snmp/wsd/windows_spooler/usb/unknown/escpos/spooler`; concurrency integer 1–64, timeout 500–30000 ms. | `src/lib/discovery.ts` |
| Discovery report | JSON object with state `running/completed/partial/failed/cancelled`; device page ≤1000 and body ≤2 MiB. Optional chunk count 1–128, zero-based index below count; nonfinal chunks are `running` and final is terminal. Candidate total, when supplied, is a safe integer 0–32000. Device fields have explicit lengths and optional fields must be omitted rather than null; port zero is invalid. Extension fields may pass through as metadata, not executable authority. | `src/app/api/agent/discovery/route.ts:15`; `contracts/print-payload-contract.json` |
| Inventory heartbeat | Body ≤512 KiB; printer page ≤500; printer ID nonempty ≤120 and name ≤100. Complete snapshots require an explicit `printers` array (`[]` for an authoritative empty inventory); supplied non-arrays return 400 before mutation. Legacy presence-only heartbeats may omit the list. Snapshot ID is bounded and uses `[A-Za-z0-9._:-]`; reported desired revision, paging/completeness and positive sharing permission are validated separately before altering inventory. One Agent cannot claim another Agent's printer ID. | `src/app/api/agent/heartbeat/route.ts:97`; `src/app/api/agent/heartbeat/route.ts:190` |

## Printer geometry, operational proof and output evidence

These are distinct contracts. Geometry describes dimensions and a configuration revision; operational proof establishes recent availability of the exact execution target; a terminal file result describes one created artifact. A model name, configured endpoint, successful TCP connection or geometry profile does not substitute for operational proof. Successful physical-printer submission does not prove paper output. The authorities are `contracts/printer-geometry-contract.json`, `contracts/printer-operational-verification-contract.json`, `src/lib/printer-geometry.ts`, `src/lib/printer-operational-verification.ts` and `src/lib/print-output.ts`.

### Geometry and desired profiles

`config.geometry_profile` is a strict object containing the measurement fields below; `printable_width_dots` is required. Create rejects null. A manager PATCH may supply `geometry_profile: null` to remove the manual profile; it does not create replacement observations. Numbers must be finite JSON numbers, never numeric strings, booleans or null. Unknown optional measurements are omitted.

| Field | Unit and inclusive bounds |
| --- | --- |
| `printable_width_dots` | Integer 1–16,384 device dots. |
| `printable_height_dots` | Optional integer 1–1,000,000 device dots. |
| `dpi_x`, `dpi_y` | Optional integers 1–9,600 dots per inch, separately for each axis. |
| `paper_width_mm`, `paper_height_mm` | Optional finite numbers strictly greater than zero and at most 10,000 millimetres; fractions are allowed. |
| `offset_x_dots`, `offset_y_dots` | Optional integers 0–1,000,000 device dots. Missing offsets remain unknown. |
| `raster_command` | Optional literal `gs_v_0`; no inferred raster command. |

When paper size and DPI are known on an axis, printable extent plus any known offset must fit `paper_mm × axis_dpi / 25.4` within one device dot. A nominal 58/80 mm roll label does not determine printable dots. A profile's dimensions must match the Agent's applied configured profile before it is exposed as current.

`capabilities.geometry` is a strict object containing those measurements plus required `version: 1`, `source`, `validation`, `observed_at`, `printer_id` and `config_fingerprint`. Source `windows_driver/ipp` requires validation `observed`; source `validated_profile` requires `configured`. The timestamp is a valid UTC RFC3339 string ending in `Z`, with optional 1–9 fractional digits. The exact printer ID is nonempty, trimmed, at most 120 code units and contains no C0/C1 controls; it must match the receiving execution record. The fingerprint is exactly 64 lowercase hexadecimal characters. Geometry timestamp syntax does not itself establish a live-device freshness proof.

Manager configuration changes clear obsolete measurements. Until desired state is both applied and observed, old geometry is not published for new image admission. Image payload fingerprints must match the current geometry. Spooler image output additionally requires paper width and both axis DPI values; direct ESC/POS raster requires an explicit `gs_v_0` profile. File-image output additionally requires paper height, printable height and both offsets. Ordinary PDF documents retain the concrete document transport's PDF capability; they do not require a cached image-geometry fingerprint. Native execution must still validate the actual destination/media and recheck current configuration before output (`src/lib/printer-capability.ts`; `src/lib/printer-geometry.ts`).

### Operational proof and identity

`capabilities.operational_verification` is a strict object. Required keys are `version`, `verified_at`, `printer_id`, `binding_digest`, `method`, `logical_queue_key`, `identity_strength`, `output_medium`; only `physical_device_key` is optional. Version is exactly 1. Printer ID has the same bounded, trimmed, control-free form above and must exactly match the observation. Digests and keys are exactly 64 lowercase hexadecimal characters, with `logical_queue_key === binding_digest`. An optional physical-device key requires `identity_strength: device`; the allowed strengths are `queue`, `service`, `device`. Queue identity and an IPP service identity do not assert a universal physical-chassis identity.

| Declared transport | Required proof method | Output medium |
| --- | --- | --- |
| `spooler` with `spooler/windows_spooler` protocol | `windows_queue` | `physical` |
| `ipp/ipps`, or `network` with `ipp/ipps` protocol | `ipp_attributes` | `physical` |
| Direct `usb` with `raw/escpos/zpl/tspl` | `usb_interface` | `physical` |
| `network` with `raw/escpos/zpl/tspl` | `snmp_printer` | `physical` |
| `pdf_output` with `pdf` protocol | `pdf_output` | `file` |

`verified_at` is a trimmed valid UTC RFC3339 `Z` timestamp with optional 1–9 fractional digits. It may be at most 300 seconds old or 60 seconds ahead of the authoritative validation clock. Gateway stores its own receipt timestamp separately. Routing/claim predicates require both timestamps to remain within their bounds; a receipt may not be in the future. For manager-owned configurations, current endpoint/protocol must match and applied/observed revisions must each reach the desired revision. Missing, invalid, stale, conflicting or wrong-destination proof leaves the printer pending; it does not silently authorize execution. A new observation cannot adopt another Agent's registration or collide with another current logical queue (`src/lib/printer-verification-sql.ts`; `src/app/api/agent/heartbeat/route.ts`).

The canonical endpoint key currently uses `v2:` plus its SHA-256 digest; display names and registration IDs are separate. The historical `physical_identity_key` column describes this endpoint deduplication key, not universal hardware identity. Job binding, tenant/Agent ownership, sharing permission and geometry fingerprint remain separate admission checks. None permits automatic reprinting of an uncertain prior outcome.

### Terminal file evidence

Agent status reports use the `outputEvidence` property. Its value is a strict object with exactly five fields: `output_medium: file`; `artifact_id` matching `^[A-Za-z0-9_-]{1,128}$`; a 64-character lowercase hexadecimal `sha256`; safe-integer `page_count` 1–10,000; and safe-integer `bytes` 1–67,108,864 (64 MiB). No filesystem path, document body or caller-selected filename is admitted in this result. Malformed supplied evidence is rejected, including explicit null (`src/lib/print-output.ts`; `agent/internal/printer/output_evidence.go`).

Evidence is required for a successful job whose admitted medium is `file` and is rejected for physical jobs or other statuses. Scope and current/closed claim authority are checked independently. A repeated terminal report must supply the same accepted file evidence; it cannot replace the artifact identity. The Gateway records the Agent's validated result and presents `outputOutcome: file_created`; it does not claim paper output or independent remote filesystem observation. Physical outcome remains `unknown` for file output. Retained receipts preserve this evidence for authorized replay without creating another file or print operation (`src/app/api/agent/jobs/route.ts`; `src/lib/print-output.ts`; `src/lib/job-maintenance.ts`).

## Administration, commercial and machine identity structures

| Item | Validation rule | Source |
| --- | --- | --- |
| Pairing | Approved six-character alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; normalize trim/uppercase. If both camelCase/snake_case aliases are supplied they must agree. Registration object is strict; hostname ≤255, client/platform ≤100, metadata serialized ≤32768 code units. A formatted code must still match a live pending pairing record and rate-limit policy. | `src/lib/agent-auth.ts`; `src/app/api/agent/register/route.ts:20` |
| Paired Agent credential | Agent ID format `^agt_[A-Za-z0-9_-]{8}$`; bearer value is `<agentId>:<secret>`. A structurally valid bearer must match the stored secret hash, active Agent and active tenant. | `src/lib/agent-auth.ts` |
| Workspace/team | Workspace name trimmed 2–120. Verified Platform Owner invitations use the signed-in workspace Team endpoint and email rule, always grant Full Access (`admin`), and are separate from Platform Admin. Ordinary workspace members cannot invite; member-role/deletion/ownership endpoints deny ordinary workspace tokens. The protected `owner` marker changes only through the dedicated Platform Owner transfer flow. | `src/app/api/settings/route.ts`; `src/app/api/platform/tenants/[id]/invitations/route.ts`; `src/lib/platform-team-security.ts` |
| Plan catalog | Create ID matches `^[a-z0-9][a-z0-9_-]{1,63}$`; nonempty trimmed name with original length ≤120; description string ≤500; monthly quota must be a JSON number that is a safe integer 1–2147483647; optional display order must be an exact JSON integer 0–1000000 (only an absent field defaults to zero; explicit null, boolean and numeric strings are rejected). Optional active/public flags must be booleans. USD/SAR catalog prices are descriptive only; no provider checkout/product/recurring billing authority exists. Platform writes require current owner proof and actor-bound idempotency. | `src/lib/manual-plans.ts`; `src/app/api/platform/plans/route.ts`; `src/app/api/platform/plans/[id]/route.ts` |
| Entitlements | Object must define `max_agents`, `max_printers`, `max_jobs_per_minute`, `max_concurrent_jobs`, `max_prints_per_period`; each a positive safe integer or literal `unlimited`. Normalize only these declared keys. A structurally valid plan does not establish a live subscription or available quota. | `src/lib/entitlements.ts:61` |
| Integration management | Installation enrollment and auto-enrollment use distinct schemas; names ≤120, key ID ≤128. Cutover requires `strict_v2` plus explicit true attestations. Collision resolution requires a scoped operation, `reuse/distinct`, expected legacy job/fingerprint and the exact history/physical-outcome attestation. | `src/app/api/odoo/installations/route.ts:16`; `src/app/api/odoo/installations/auto/route.ts:15`; `src/app/api/odoo/installations/cutover/route.ts:13`; `src/app/api/odoo/installations/resolutions/route.ts:15` |
| Destructive platform actions | Strict action-specific schemas; bounded tenant/resource IDs, expected lifecycle and explicit confirmation or compatible exact confirmation ID. Reasons are bounded free text, not SQL or commands. The referenced resource is looked up and rechecked under current platform authority. | `src/app/api/platform/fleet/lifecycle/route.ts:21`; `src/app/api/platform/fleet/delete/route.ts:10`; `src/app/api/platform/integrations/remove/route.ts:14`; `src/app/api/platform/tenants/[id]/delete/route.ts:10` |
| Database explorer | Table identifier matches the declared lowercase grammar but must also belong to the application's table catalog; text search ≤100 and offset integer 0–10000. A matching identifier never permits arbitrary SQL execution or access to secret columns. | `src/app/api/platform/database/route.ts:8`; `src/lib/platform-data-explorer.ts` |
| Metrics collector | Exactly `GET /api/metrics`, no query, and `Authorization: Bearer ` followed by 64 hexadecimal characters. Key file is a bounded regular file with independent 32-byte material; malformed/merged headers cannot fall back to ambient cookies. | `src/lib/metrics-machine-auth.ts`; `src/app/api/metrics/route.ts` |

## Cross-component rules and maintenance

Odoo's editable Gateway destination is separately validated before each outbound request; it is not a general-purpose arbitrary HTTP fetch. The Tauri/Agent Gateway-origin and printer-address rules are likewise applied by their native implementations, not solely by browser widgets. The communication document identifies each location and its relevant source policy. Odoo model constraints retain company/branch, installation and immutable operation relationships in addition to field validation (`odoo_addons/print_gateway/models/print_job.py:502`; `odoo_addons/print_gateway/models/gateway_destination.py`).

For every new input or changed field, document the type, required/optional/null behavior, normalization, length/range/enum, unknown-property policy, correlated fields and owning semantic validator. Place the rule at the server/native trust boundary, then keep the shared contract and this document synchronized. UI validation is a usability aid, not a substitute for the receiving boundary.

Review this documentation by comparing the appendix to all Zod imports and the manual-rule tables to their named parsers; check both create and patch variants. Existing focused suites include `tests/payload.test.ts`, `tests/discovery-security.test.ts`, `tests/printer-destination-security.test.ts`, `tests/email-auth-token-lifetime.integration.test.ts`, `tests/workspace-session-security.integration.test.ts` and `tests/password-only-auth.integration.test.ts`; use the repository's test groups and real PostgreSQL setup for integration suites. Select boundary/invalid-format regressions for an affected parser rather than treating passing unrelated tests as validation of a new format. Physical printer, provider and selected-runtime acceptance remains governed by the corresponding release documents.

## Schema appendix

The following declarations make action enums, optional fields, type/coercion choices and unknown-property behavior explicit. They are a source snapshot of the named declarations, not a replacement for the semantic validators above. Keep them synchronized when the implementation changes. A `z.unknown()` or metadata record delegates validation to the named downstream contract; it does not authorize persistence, execution or access by itself.

### src/app/api/agent/discovery/route.ts — deviceSchema

Source: `src/app/api/agent/discovery/route.ts:29`. This is the declared field structure; the preceding semantic rules still apply.

```ts
deviceSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  stableId: z.string().min(1).max(120).optional(),
  source: z.array(z.string().max(64)).max(32).optional(),
  protocol: z.string().min(1).max(32).optional(),
  ipAddress: z.string().max(45).optional(),
  hostname: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  uri: z.string().max(1024).optional(),
  deviceName: z.string().max(255).optional(),
  spoolerName: z.string().max(255).optional(),
  deviceClass: z.enum(["thermal", "laser", "inkjet", "label", "other", "unknown"]).optional(),
  transport: z.string().max(32).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(120).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  verification: z.enum(["candidate", "verified"]).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
```

### src/app/api/agent/discovery/route.ts — errorsResult

Source: `src/app/api/agent/discovery/route.ts:92`. This is the declared field structure; the preceding semantic rules still apply.

```ts
errorsResult = z.array(z.string().max(2048)).max(64).safeParse(bodyRecord.errors ?? [])
```

### src/app/api/agent/register/route.ts — registrationSchema

Source: `src/app/api/agent/register/route.ts:20`. This is the declared field structure; the preceding semantic rules still apply.

```ts
registrationSchema = z.object({
  pairingCode: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  pairing_code: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  hostname: z.string().trim().max(255).optional(),
  client_version: z.string().trim().max(100).optional(),
  clientVersion: z.string().trim().max(100).optional(),
  platform: z.string().trim().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().trim().min(1).max(120).optional(),
  agent_id: z.string().trim().min(1).max(120).optional(),
}).strict().refine((data) => Boolean(data.pairingCode || data.pairing_code), {
  message: "pairing_code or pairingCode is required",
}).refine((data) => {
  if (data.pairingCode && data.pairing_code && data.pairingCode.toUpperCase() !== data.pairing_code.toUpperCase()) {
    return false;
  }
  if (data.agentId && data.agent_id && data.agentId !== data.agent_id) {
    return false;
  }
  if (data.clientVersion && data.client_version && data.clientVersion !== data.client_version) {
    return false;
  }
  return true;
}, {
  message: "Conflicting alias fields provided",
})
```

### src/app/api/agents/[id]/route.ts — patchSchema

Source: `src/app/api/agents/[id]/route.ts:18`. This is the declared field structure; the preceding semantic rules still apply.

```ts
patchSchema = z.object({ lifecycle: z.enum(["active", "disabled", "retired"]) }).strict()
```

### src/app/api/agents/route.ts — createAgentSchema

Source: `src/app/api/agents/route.ts:18`. This is the declared field structure; the preceding semantic rules still apply.

```ts
createAgentSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict()
```

### src/app/api/auth/reauth/password/route.ts — inputSchema

Source: `src/app/api/auth/reauth/password/route.ts:17`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({ password: z.string().min(1).max(4096) }).strict()
```

### src/app/api/auth/sessions/route.ts — inputSchema

Source: `src/app/api/auth/sessions/route.ts:19`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({ action: z.enum(["revoke", "revoke_others", "revoke_all"]), id: z.string().max(150).optional(), password: z.string().min(1).max(4096) }).strict()
```

### src/app/api/odoo/installations/auto/route.ts — schema

Source: `src/app/api/odoo/installations/auto/route.ts:15`. This is the declared field structure; the preceding semantic rules still apply.

```ts
schema = z.object({
  installationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  installationProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(120).optional(),
}).strict()
```

### src/app/api/odoo/installations/cutover/route.ts — schema

Source: `src/app/api/odoo/installations/cutover/route.ts:13`. This is the declared field structure; the preceding semantic rules still apply.

```ts
schema = z.object({
  mode: z.literal("strict_v2"),
  verifiedExternalOutboxes: z.literal(true),
  verifiedReceiptBackup: z.literal(true),
  verifiedAllInstallationsEnrolled: z.literal(true),
}).strict()
```

### src/app/api/odoo/installations/resolutions/route.ts — operationSchema

Source: `src/app/api/odoo/installations/resolutions/route.ts:15`. This is the declared field structure; the preceding semantic rules still apply.

```ts
operationSchema = z.object({
  installationId: z.string().uuid(),
  sourceCompanyId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  sourceOperationId: z.string().min(1).max(200),
}).strict()
```

### src/app/api/odoo/installations/resolutions/route.ts — approveSchema

Source: `src/app/api/odoo/installations/resolutions/route.ts:20`. This is the declared field structure; the preceding semantic rules still apply.

```ts
approveSchema = operationSchema.extend({
  disposition: z.enum(["reuse", "distinct"]),
  expectedLegacyJobId: z.string().trim().min(1).max(128),
  expectedLegacyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  // A separate human reconciliation decision is required, not a similarity
  // heuristic based on matching bytes, Odoo company ID or a copied DB name.
  operatorAttestation: z.literal("HISTORY_AND_PHYSICAL_OUTCOME_REVIEWED"),
})
```

### src/app/api/odoo/installations/route.ts — enrollSchema

Source: `src/app/api/odoo/installations/route.ts:16`. This is the declared field structure; the preceding semantic rules still apply.

```ts
enrollSchema = z.object({
  name: z.string().trim().min(1).max(120),
  apiKeyId: z.string().trim().min(1).max(128),
}).strict()
```

### src/app/api/odoo/keys/route.ts — keyInputSchema

Source: `src/app/api/odoo/keys/route.ts:16`. This is the declared field structure; the preceding semantic rules still apply.

```ts
keyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/platform/auth/reauth/route.ts — input

Source: `src/app/api/platform/auth/reauth/route.ts`. Origin, exact live SID, current owner and password binding are checked in addition to this strict shape.

```ts
input = z.object({ password: z.string().min(1).max(4096) }).strict();
```

### src/app/api/platform/auth/sessions/route.ts — inputSchema

Source: `src/app/api/platform/auth/sessions/route.ts:11`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({ action: z.enum(["revoke", "revoke_others", "revoke_all"]), id: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict()
```

### src/app/api/platform/database/route.ts — querySchema

Source: `src/app/api/platform/database/route.ts:8`. This is the declared field structure; the preceding semantic rules still apply.

```ts
querySchema = z.object({
  table:z.string().regex(/^[a-z][a-z0-9_]{0,90}$/).optional(),
  q:z.string().trim().min(1).max(100).optional(),
  offset:z.coerce.number().int().min(0).max(10000).default(0),
})
```

### src/app/api/platform/fleet/delete/route.ts — schema

Source: `src/app/api/platform/fleet/delete/route.ts:10`. This is the declared field structure; the preceding semantic rules still apply.

```ts
schema = z.object({
  kind: z.enum(["agents", "printers"]),
  tenantId: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(150),
  expectedLifecycle: z.enum(["active", "disabled", "retired"]),
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(150).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/platform/fleet/lifecycle/route.ts — bodySchema

Source: `src/app/api/platform/fleet/lifecycle/route.ts:21`. This is the declared field structure; the preceding semantic rules still apply.

```ts
bodySchema = z.object({
  kind: z.enum(["agents", "printers"]),
  tenantId: z.string().min(1).max(120),
  id: z.string().min(1).max(150),
  expectedLifecycle: z.enum(["active", "disabled"]),
  nextLifecycle: z.enum(["active", "disabled"]),
  reason: z.string().trim().max(300).optional(),
}).strict()
```

### src/app/api/platform/integrations/quarantine/route.ts — inputSchema

Source: `src/app/api/platform/integrations/quarantine/route.ts:16`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(150),
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(150).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/platform/integrations/remove/route.ts — inputSchema

Source: `src/app/api/platform/integrations/remove/route.ts:14`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(150),
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(150).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/platform/integrations/revoke/route.ts — inputSchema

Source: `src/app/api/platform/integrations/revoke/route.ts:16`. This is the declared field structure; the preceding semantic rules still apply.

```ts
inputSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(150),
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(150).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/platform/tenants/[id]/delete/route.ts — schema

Source: `src/app/api/platform/tenants/[id]/delete/route.ts:10`. This is the declared field structure; the preceding semantic rules still apply.

```ts
schema = z.object({
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(120).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict()
```

### src/app/api/print/jobs/batch-status/route.ts — batchQuerySchema

Source: `src/app/api/print/jobs/batch-status/route.ts:15`. This is the declared field structure; the preceding semantic rules still apply.

```ts
batchQuerySchema = z.object({
  jobIds: z.array(z.string().min(1).max(120).refine(isExactPrinterId)).min(1).max(100),
}).strict()
```

### src/app/api/print/jobs/route.ts — bodySchema

Source: `src/app/api/print/jobs/route.ts:36`. This is the declared field structure; the preceding semantic rules still apply.

```ts
bodySchema = z.object({
  printerId: z.string().min(1).max(120).refine(isExactPrinterId, { message: "printerId must be the exact configured printer identity" }),
  documentType: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(255).optional(),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200).refine(isExactIdempotencyKey, { message: "idempotencyKey must match the original operation exactly" }).optional(),
  // S06-006: optional only for legacy callers; v2 fields must travel together.
  idempotencyVersion: z.literal(2).optional(),
  installationId: z.string().optional(),
  sourceCompanyId: z.string().optional(),
  sourceOperationId: z.string().optional(),
}).strict()
```

### src/app/api/print/jobs/v2/route.ts — bodySchema

Source: `src/app/api/print/jobs/v2/route.ts:20`. This is the declared field structure; the preceding semantic rules still apply.

```ts
bodySchema = z.object({
  printerId: z.string().min(1).max(120).refine(isExactPrinterId, { message: "printerId must be the exact configured printer identity" }),
  documentType: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(255).optional(),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200).refine(isExactIdempotencyKey, { message: "idempotencyKey must match the original operation exactly" }),
  // S06-006: optional only for legacy callers; v2 fields must travel together.
  idempotencyVersion: z.literal(2).optional(),
  installationId: z.string().optional(),
  sourceCompanyId: z.string().optional(),
  sourceOperationId: z.string().optional(),
}).strict()
```

### src/app/api/printers/[id]/route.ts — patchSchema

Source: `src/app/api/printers/[id]/route.ts:24`. This is the declared field structure; the preceding semantic rules still apply.

```ts
patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  printerType: z.enum(PRINTER_TYPES).optional(),
  deviceClass: z.enum(["thermal", "laser", "inkjet", "label", "other", "unknown"]).optional(),
  connectionType: z.enum(CONNECTION_TYPES).optional(),
  protocol: z.enum(PRINTER_PROTOCOLS).optional(),
  lifecycle: z.enum(["active", "disabled", "retired"]).optional(),
  config: z.object({
    ip: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    vid: z.number().int().min(0).max(65535).optional(),
    pid: z.number().int().min(0).max(65535).optional(),
    serial: z.string().max(255).optional(),
    address: z.string().max(512).optional(),
    spooler_name: z.string().max(255).optional(),
    output_profile_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    passthrough_protocols: z.array(z.enum(["raw", "escpos"])).max(2).optional(),
    paper_widths: z.array(z.number().int().min(1).max(500)).max(32).optional(),
    color_capable: z.boolean().optional(),
    duplex_capable: z.boolean().optional(),
    geometry_profile: printerGeometryProfileSchema.nullable().optional(),
  }).strict().optional(),
}).strict()
```

### src/lib/discovery.ts — discoveryStartSchema

Source: `src/lib/discovery.ts:11`. This is the declared field structure; the preceding semantic rules still apply.

```ts
discoveryStartSchema = z.object({
  cidr: z.string().optional(),
  protocols: z.array(z.enum(DISCOVERY_PROTOCOLS)).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(500).max(30000).optional(),
}).strict()
```

### src/lib/payload.ts — printJobPayloadSchema

Source: `src/lib/payload.ts:14`. This is the declared field structure; the preceding semantic rules still apply.

```ts
printJobPayloadSchema = z.object({
  type: z.enum(PAYLOAD_TYPES),
  encoding: z.literal(payloadContract.encoding),
  protocol: z.enum(RAW_PROTOCOLS).optional(),
  geometry_fingerprint: z.string().regex(GEOMETRY_FINGERPRINT_PATTERN, "geometry_fingerprint must be lowercase SHA256 hex").optional(),
  peripherals: z.object({
    drawer: z.enum(DRAWER_MODES).optional(),
    cutter: z.enum(CUTTER_MODES).optional(),
    buzzer: z.enum(BUZZER_MODES).optional(),
    // Strict: an unknown peripheral key (e.g. a "cuttter" typo) must fail
    // admission loudly instead of printing without the requested device
    // action. The wire contract lists exactly these three keys.
  }).strict().optional(),
  data: z.string().min(1).max((MAX_PAYLOAD_BYTES / 3) * 4 + 8, { message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` }),
}).superRefine((payload, ctx) => {
  // Optional at the syntax boundary so historical accepted image operations
  // can still reconcile their exact original payload. New image admission
  // requires a matching fingerprint under the authoritative printer row lock.
  if (payload.type !== "image" && payload.geometry_fingerprint !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["geometry_fingerprint"], message: "geometry_fingerprint is only applicable to image payloads" });
  }
  // Single base64 decode for the whole admission: the round-trip check below
  // rejects non-canonical input, then every signature check reuses `decoded`.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(payload.data, "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length === 0 || decoded.length > MAX_PAYLOAD_BYTES || decoded.toString("base64") !== payload.data) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` });
    return;
  }
  const pdfSignature = Buffer.from(payloadContract.signatures.pdfPrefix);
  const jpegSignature = decoded.length >= 3 && decoded.subarray(0, 3).equals(Buffer.from(payloadContract.signatures.jpegHexPrefix, "hex"));
  const looksLikePdf = decoded.length >= pdfSignature.length && decoded.subarray(0, pdfSignature.length).equals(pdfSignature);

  if (payload.type === "pdf" && !looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload must start with the %PDF- signature" });
  }
  // The Windows Agent's ValidatePDF refuses documents without a %%EOF marker
  // in the final 4 KiB. Reject those at Gateway admission, before creating a
  // durable job that is guaranteed to fail after Agent delivery.
  if (payload.type === "pdf" && looksLikePdf && !decoded.subarray(Math.max(0, decoded.length - 4096)).includes(Buffer.from("%%EOF"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload is incomplete (missing %%EOF trailer)" });
  }
  if (payload.type === "image" && !jpegSignature) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "Image payload must be a JPEG" });
  }
  if ((payload.type === "raw" || payload.type === "escpos") && looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF bytes cannot be labeled as raw/escpos; provide a real byte-stream payload or convert explicitly" });
  }

  if (payload.type === "raw") {
    if (!payload.protocol) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is required for raw payloads" });
    }
  }
  if (payload.type === "escpos") {
    if (!payload.protocol || payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol 'escpos' is required for escpos payloads" });
    }
  }
  if ((payload.type === "pdf" || payload.type === "image") && payload.protocol) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is not applicable for pdf/image payloads" });
  }
  if (payload.peripherals) {
    const hasPeripherals = [payload.peripherals.drawer, payload.peripherals.cutter, payload.peripherals.buzzer]
      .some((mode) => Boolean(mode) && mode !== "none");
    if (hasPeripherals && payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["peripherals"], message: "peripherals are only supported for escpos protocol" });
    }
  }
})
```

### src/lib/printer-model.ts — printerGeometryProfileSchema

Source: `src/lib/printer-model.ts:5`. This is the declared field structure; the preceding semantic rules still apply.

```ts
printerGeometryProfileSchema = z.unknown().transform((value, ctx): PrinterGeometryProfile => {
  const result = validatePrinterGeometryProfile(value);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.value;
})
```

### src/lib/printer-model.ts — printerInputSchema

Source: `src/lib/printer-model.ts:20`. This is the declared field structure; the preceding semantic rules still apply.

```ts
printerInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).max(120).optional(),
  agentId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(100),
  printerType: z.enum(PRINTER_TYPES).default("physical"),
  deviceClass: z.enum(DEVICE_CLASSES).default("unknown"),
  connectionType: z.enum(CONNECTION_TYPES).default("network"),
  protocol: z.enum(PRINTER_PROTOCOLS),
  config: z.object({
    ip: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    vid: z.number().int().min(0).max(65535).optional(),
    pid: z.number().int().min(0).max(65535).optional(),
    serial: z.string().max(255).optional(),
    address: z.string().max(512).optional(),
    spooler_name: z.string().max(255).optional(),
    output_profile_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    paper_widths: z.array(z.number().finite().positive().max(1000)).max(32).optional(),
    color_capable: z.boolean().optional(),
    duplex_capable: z.boolean().optional(),
    // Windows spooler queues are document-capable by default. Byte-stream
    // passthrough is an explicit operator opt-in, never inferred from model
    // class or the presence of a local Windows queue.
    passthrough_protocols: z.array(z.enum(["raw", "escpos"])).max(2).optional(),
    geometry_profile: printerGeometryProfileSchema.optional(),
  }).strict().default({}),
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict()
```
