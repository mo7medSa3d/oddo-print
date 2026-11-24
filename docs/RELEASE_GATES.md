# Release acceptance and recovery

This document is the operational gate for the V5 source hardening candidate.
The source package is a release candidate, **not an authorization to deploy**.
The separately delivered `YASEIR_V4_PRODUCTION_READINESS.md` and its verification
archive describe the historical V4 baseline. Repeat the applicable gates against
the exact current candidate; historical passes do not establish a V5 pass. A
missing Windows, hardware or staging result must remain blocked, even when
software unit tests pass.

The `/platform/release-readiness` engineering checklist is internal: the server requires
a live Platform Owner session, including its session policy. Customer and
workspace manager sessions cannot view it or select it as a workspace return
destination. Automated release checks remain available independently of this UI.

## Supported execution boundaries

| Component | Build/runtime contract | Acceptance still required |
| --- | --- | --- |
| Gateway | Node version in `.nvmrc`, locked npm dependencies, Next production build, PostgreSQL 16+ | Production image, private networking, real proxy/TLS, alerting and sustained load |
| Go agent | Go version in `agent/go.mod`, read-only module graph, durable SQLite queue | Real Windows/CGO build; SCM/GDI/spooler/USB and supported printer models |
| Desktop | Rust version in `src-tauri/rust-toolchain.toml` where present, locked Cargo graph, Tauri/NSIS | Real MSVC/Windows SDK build, WebView2, installer/update/uninstall, signed artifact |
| Odoo addon | Odoo 19; addon `19.0.2.36.0`; persistent data directory; deployment-managed encryption keys | Exact hardened upstream runtime, production addon upgrade, POS/report/printer acceptance |

Read `docs/runtime-hardening/` for the exact Odoo runtime dependency
set and upstream PDF decompression patch. An audit of dependency metadata alone
does not establish that upstream monkeypatches preserve a library's safeguards.
Do not substitute an arbitrary Odoo image and assume this runtime evidence
applies to it. The GTK/GLib source backports, original crate checksums, precise
upstream repair and optimized regression gates are documented in
`src-tauri/vendor/README.md`. Local path crates still require that source review;
a clean dependency scanner alone does not establish their safety. Linux GUI
acceptance and the remaining upstream compiler diagnostics remain separate.

For the exact signed Windows candidate, follow
`docs/WINDOWS_RELEASE_ACCEPTANCE.md` and start with the blocked result template
in `docs/acceptance/windows-result-template.json`. Its verifier binds installed
bytes, publisher, SCM executable and WebView2 to the recorded candidate. Every
unexecuted Windows lifecycle, native API and physical-printer gate stays blocked.

## Reproduce the software gates

Run in a clean checkout with the pinned toolchains, an isolated PostgreSQL
database and synthetic fixture data. Never point integration tests at a
production database. The database role must be able to create the temporary
schemas/databases required by each test procedure.

Supply the isolated test connection URL through the private verification
environment as `YASEIR_ISOLATED_TEST_DATABASE_URL`, then export it explicitly
below. The integration tripwire requires `DATABASE_URL`; supplying only `PG*`
settings is not sufficient for that gate. Use a dedicated disposable database
and test role, with no production connection value or credentials in this file.

```bash
export DATABASE_URL="${YASEIR_ISOLATED_TEST_DATABASE_URL:?Set the isolated synthetic PostgreSQL URL}"
npm ci
python3.12 -m venv .venv-verification
. .venv-verification/bin/activate
python -m pip install -r requirements-test.txt
npm run typecheck
npm run lint
npm run i18n:check
npm run i18n:odoo:check
npm run db:docs:check
npm run typography:check
node --experimental-vm-modules --test tests/*.test.mjs
python3 -m pytest tests/test_*.py
npm run test:unit
npm run build
npm run db:migrate
RUN_MULTI_INSTANCE_TEST=1 RUN_DB_BACKED_ACCEPTANCE=1 npm run test:integration
```

The CI workflow pins Python test tooling. Run pyflakes, source inventory,
secret/dependency scans and immutable-action/image checks as defined there.
Record exact test counts: a command returning zero without actual assertions
is not a test pass. Keep baseline failures, fixes and completed reruns separately.

```bash
cd agent
go mod verify
go test -mod=readonly ./...
go test -mod=readonly -race -vet=all ./...
go vet -mod=readonly ./...
staticcheck -checks=U1000 ./...
```

On a supported native build host, run `cargo fmt --check`, `cargo check --locked`,
`cargo test --locked` and `cargo clippy --locked` from `src-tauri`, then build
the actual bundle. Missing GLib/WebKit/MSVC/SDK prerequisites are blockers,
not successful cross-platform builds. The Linux source verification performed
for this candidate does not execute Win32 code.

## Upgrade order and installation identity

1. Record the old release, Gateway migration hashes, Odoo version, agent/desktop
   versions and exact container/binary digests. Stop new print admission and
   drain/reconcile in-flight work before changing distributed components.
2. Back up PostgreSQL, Odoo database/filestore, deployment-managed Odoo encryption
   key versions, Odoo `data_dir/yaseir-print-installations/`, and protected agent
   configuration/SQLite/sharing state. Keep independent encrypted copies and
   restore them in recovery before release. Do not place keys inside a source ZIP.
3. Upgrade the addon to `19.0.2.36.0` before enforcing the Gateway status-read
   contract. Its status batches carry each saved job's version and installation
   proof. Older addon status requests may be rejected by a strict-v2 Gateway.
   Preserve saved operation keys and proofs; do not turn reconciliation failure
   into a new print operation.
   The direct Odoo Agent registration path now stores deployment-keyed HMAC
   digests for pairing codes. Confirm the active `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V{n}_B64`
   secret is mounted before generating codes, reissue every pending code after
   this upgrade/key rotation, and verify registration returns a closed failure
   when the key is absent. Before exposing `/api/agent/register`, enforce
   source-aware and aggregate attempt throttling at the trusted edge or with a
   durable shared limiter; HMAC protects against offline database enumeration
   but does not stop online guessing. Record the negative tests and rate-limit
   headers/behaviour in the release evidence.
4. Stop every older Gateway instance before applying the forward migrations
   with `npm run db:migrate`, then start only the matching V5 Gateway. Never
   rewrite existing SQL or repair hashes.
   Migration 0081 already present in the input removes virtual/redirected
   destinations/history and refuses affected active jobs; its existing backup
   and drain warning remains mandatory. V3 migration 0093 explicitly drops the
   retired factor-only tables and columns while preserving accounts, password
   verifiers, memberships and nonfactor session history. Retain the verified
   pre-upgrade backup: those removed factor records cannot be recreated by
   reverting application code, and a V2 binary is incompatible with the V3
   schema. Migration 0094 records current operational verification, immutable
   job binding and file-output evidence. Existing queued jobs without an admitted
   binding remain pending; an upgrade must not guess or backfill their target
   from a mutable printer row. See `MIGRATION.md` for populated-upgrade and
   rollback evidence. V4 migration 0095 preserves provider/history records,
   separates manual subscriptions from authenticated requests and initializes
   the original UTC calendar-month ledger conservatively (historical migration only). Review its cutover
   usage before admitting jobs. Retired provider routes cannot renew access;
   reconcile any previous external recurring charges separately.
5. Upgrade the compatible agent/desktop together, preserving machine data and
   desired-state version fences. Confirm heartbeat and shared-printer inventory
   convergence and fresh native verification before admitting work. A configured
   name, address, capability or old status does not make a printer eligible.
   Configure any approved PDF output profiles in the Agent's local administrator
   allowlist and verify them before use. Older clients must never apply a truncated
   desired-state page as a complete replacement.
6. Run one controlled software job, inspect its durable receipt, then complete
   the authorized physical acceptance matrix before enabling general traffic.

For step 3, stop the existing Odoo service first and run the ordinary upgrade
with the verified runtime profile. Supply the paths and database through the
private release environment; the configuration must retain the deployment's
complete `addons_path`, the same `data_dir`/filestore/installation-proof
directory, database connection and encryption-key environment.

```bash
"${YASEIR_ODOO_VENV:?Set the verified Odoo venv}/bin/python" \
  "${YASEIR_ODOO_SOURCE:?Set the pinned patched Odoo source}/odoo-bin" server \
  --config "${YASEIR_ODOO_CONFIG:?Set the existing private Odoo configuration}" \
  --database "${YASEIR_ODOO_DATABASE:?Set the authorized upgrade database}" \
  --update print_gateway --stop-after-init --no-http \
  --workers=0 --max-cron-threads=0
```

Require exit zero and inspect the upgrade log before restarting Odoo with its
normal service configuration. The full `post_install` regression suite belongs
on a fresh disposable test database; do not add it to this ordinary deployment
upgrade command. The release evidence includes a failed test-on-upgrade fixture
attempt separately from the successful ordinary upgrade and fresh native suite.

New workspaces default to strict-v2. **Legacy workspaces never auto-promote on
the basis of empty Gateway history.** A disconnected Odoo outbox may still
contain historical work. Use the permission-checked installation, resolution
and cutover endpoints documented in `ODOO_INTEGRATION.md` and `API.md` with an
operator-reviewed mapping of `reuse` versus `distinct`. Record old receipts and
audit decisions. Never infer that identical external order IDs in different
databases represent the same job.

An ordinary same-name restore must retain the corresponding external proof.
A database-only clone receives a distinct scope and cannot replay the original
v2 outbox. A full host clone can copy both the database and proof; operators must
provision an independent identity scope and reconcile history deliberately.

## Production configuration and staging

Use `.env.example` as a variable inventory, not production credentials.
Production needs a clean HTTPS `APP_BASE_URL`, private Gateway/DB ports, a real
`PLATFORM_TENANT_ID`, unique random session/proxy secrets and secure cookies.
Use mounted secret files and least-privilege DB roles. Set the same nonsecret
`YASEIR_DEPLOYMENT_ID` at image build and runtime. Do not expose the backend
directly or enable HTTP, host-fallback or plaintext-password development flags.

| Setting | Isolated local verification | Staging / production |
| --- | --- | --- |
| Data | Disposable synthetic tenants and documents | Authorized isolated staging first; backup and retention policy for production |
| TLS | API/native clients explicitly trust the test CA; Chromium uses a fixture-leaf SPKI pin after independent CA verification | Public trusted certificate; renewal and expiry alerts exercised without test pins or trust bypass |
| Proxy | Loopback-only or isolated private network | Validated trusted-proxy secret and private backend port |
| Manual subscriptions | Authenticated request, explicit owner approval, quota/race and retired-provider tests | Authorized staging activation, contact details and verified download URL; reconcile any historical external recurring charge separately |
| Email | Fake transport, no external recipients | Provider sandbox/authorized test mailbox before customer delivery |
| Printers | Isolated software transport, no LAN discovery | Explicitly authorized physical devices and supported models |
| Secrets | Ephemeral private fixture files | Secret manager/mounts, key rotation and disaster-recovery ownership |

Validate `docker compose config`, build the pinned multi-stage image, scan its
actual final layers and start a separate staging stack. Test `/api/live` and
`/api/health`, login/refresh/logout, two-tenant negative access, billing events,
agent revocation, reconnects, migration/restore and Odoo status proof handling.
Run `node scripts/check-public-gateway.mjs https://your-authorized-origin` from
outside the host to verify public HTTPS and unauthenticated WSS rejection.
No self-signed trust bypass or `--insecure` flag is acceptable for that gate.

## Windows and physical printing

From a prepared Windows build host, use:

```powershell
pwsh -File scripts/build-windows-installer.ps1 -Bundles nsis
```

The build produces an installer; it does not install the release. Select the
exact newly built artifact under
`src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\`, record
`Get-FileHash -Algorithm SHA256`, and use `Get-AuthenticodeSignature` to verify
`Status = Valid` and the release owner's expected signer identity/thumbprint.
The build uses `WINDOWS_CERTIFICATE_THUMBPRINT` from the owner's certificate
store when configured. Do not select an older installer by an ambiguous glob.

On a clean acceptance VM, run that verified installer to completion and record
the exact chosen installation directory. For the upgrade case, first install
the retained prior release with synthetic pairing/queue state, then upgrade it
with this same verified candidate. Confirm the installed manager, agent and
helper hashes/versions correspond to the candidate before running:

```powershell
pwsh -File scripts/smoke-test-windows.ps1 -InstallDir "C:\the-exact-acceptance-install-directory"
```

The path above is an operator-supplied placeholder. An explicit directory and
installed-artifact comparison prevent the smoke test from discovering and
testing an unrelated previously installed copy.

Do not use skip-test switches for release acceptance. Use the release owner's
code-signing identity; keep keys outside source. A self-signed development
certificate is not a publicly trusted publisher signature. Record installer
hash, signature verification, OS build, user privileges and printer driver.

Verify fresh install, upgrade preserving machine identity and SQLite state,
restart/reboot, concurrent UI launches, service-owned process detection,
uninstall recovery and restricted ACLs. Read `WINDOWS_SERVICE_RECOVERY.md` for
the existing recovery contract. Test GDI/PDF, IPP/PDF, supported RAW languages,
USB, and each claimed thermal printer class. Use both 58 mm and 80 mm paper,
actual printable width, Latin/Arabic text, tax/refund cases, long receipts,
images and mixed content. Retain photographs/scans plus spooler and Gateway
job IDs. Test unplug/replug, paper out, cancellation, partial write, stalled
renderer, network loss and restart while printing.

**Gateway success means the reported transport accepted work; it does not
prove paper output.** An unknown/partial outcome must never trigger automatic
duplicate printing. Inspect device/spooler evidence and intentionally create a
new reprint attempt only after reconciliation. Never delete the agent queue or
rewrite a historical job to `queued` to remove uncertainty.

## Billing, authentication and operational release gaps

V4 has no active payment-provider integration or automated settlement. Exercise
the authenticated request, Platform Owner approval, free/paid classification,
monthly/yearly/custom dates, renewal, quota override, suspension/reactivation,
stale mutation and replay flows in authorized staging. Confirm that only the
explicit audited owner action grants access, that the monthly UTC ledger does
not reset on renewal, and that retired provider endpoints return 410 without
mutations. Configure the external contact and signed Windows download URL.
Payment settlement and any required invoice remain outside Yaseir. Migration
does not cancel historical external charges; reconcile them operationally.

Every human role uses email/password login followed by its scoped session and dashboard. Current owner/membership authorization, database-backed attempt reservations, screened new passwords, secure cookies, exact live session IDs and password-verifier binding remain mandatory. New passwords use local common/contextual checks and the padded HIBP prefix protocol; see `security/PASSWORD_SCREENING.md`. Both security interfaces list only the signed-in account's live sessions across its workspaces, with bounded account-bound pagination. Workspace session revocation requires the actual password; platform-target revocation also requires current same-account platform authority and recent platform password confirmation.

Privileged mutations require a password verified within five minutes. Reauthentication rotates both credentials, immediately denies predecessor tokens and retains the absolute deadline. Workspace idle expiry is thirty minutes with a thirty-day absolute cap; platform idle expiry is thirty minutes with an eight-hour cap. Background status/refresh does not count as activity. Invitation acceptance and workspace switching inherit password proof and earliest expiry. Production authentication and locale cookies retain `__Host-`, Secure and Path=/, with HttpOnly for authentication. Former cookie names are not a production fallback. Paired Agent/desktop credentials retain their separate machine policy.

The password-only product policy leaves ASVS V6.3.3 unsatisfied and removes the previous factor-based evidence for other affected V6/V7 requirements. Record that as an explicit exception/failure; do not relabel a mandatory combined-authentication requirement N/A or claim equivalent phishing resistance. A correct password, including one obtained by phishing or keylogging, can sign in as a Platform Owner. Password confirmation addresses stolen-session use only when the attacker lacks that password. There is no overall ASVS Level 2 certification claim. See `docs/PASSWORD_AUTHENTICATION.md` and the release's requirement matrix for source-bound evidence and deployment gaps.

The actual browser gate covers immediate login, secure cookies, password confirmation, CSRF refusal, session revocation/expiry, explicit mutation retry and English/Arabic rendering. Synthetic local HTTPS does not establish public PKI, deployed proxy configuration, live email-provider acceptance, Odoo identity policy, Windows/WebView2 execution or physical printer behavior; those remain separate gates.

Configure a separate protected log collector and working alerts before release.
Baseline readiness failures, API errors/latency, old queued/printing jobs,
unknown outcomes, stale agents, DB pool pressure, billing identity conflicts,
backup freshness and certificate expiry. Trigger each alert using an authorized
staging fault, confirm the receiver and response runbook, and retain evidence.
Use measured staging load to set thresholds; this candidate's short local
benchmark does not establish a sustained jobs/minute guarantee or production SLO.

## Backup, rollback and incident response

The repository's backup helper writes restrictive custom-format archives and
checksum sidecars. The restore helper verifies the selected archive, refuses
any nonempty target, without a destructive override, and restores in one transaction. Use libpq secret
files and a dedicated empty recovery database; see `DEPLOYMENT.md` for exact
commands. Re-run migrations and integrity checks before allowing traffic.

Rollback begins by stopping new admission, preserving logs and all durable job
ledgers, and reconciling submitted/unknown jobs. Prefer a compatible code rollback
or forward fix. Do not downgrade to pre-proof status authorization, undo strict-v2
identity, rewrite migration history or delete pending work. If database restore
is required, restore the matched database, Odoo filestore/proofs/keys and agent
state in isolation, compare canonical relations, then reconnect one agent.
Restoring only one member of that distributed state can duplicate or strand work.

For suspected compromise: disable the affected tenant/agent/key through audited
authority, revoke sessions, rotate exposed credentials, preserve separate logs,
bound document access and reconcile physical outcomes before replay. Establish
owner-approved RPO/RTO from actual backup cadence and rehearsed restore duration;
the synthetic local restore time is not a customer recovery promise.

Release only after every applicable gate has a real result, known High/Critical
findings are closed or safely mitigated with evidence, and the owner has reviewed
the final source/binary checksums, rollback inputs and remaining exceptions.
