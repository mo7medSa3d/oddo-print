# Desktop Manager login, connection probe, and Windows virtual-queue diagnostics

This procedure describes the current source behavior, not a successful on-site acceptance run. A new Windows installer must be built from the amended source and tested on the actual target OS. No default production `admin` user or password is provisioned by the Agent.

## Manager authentication

1. In Desktop **Settings**, enter the Gateway **origin** (for example `https://gateway.example.com`). The **Check Connection** button probes `/api/agent/probe` and only saves the configured origin after a successful response. A blank/invalid/unreachable origin shows a recoverable error and does not replace the last saved Gateway.
2. Sign in using an **email-verified Gateway user** who belongs to the workspace resolved for the Gateway hostname, and has the `owner`, `admin`, or `operator` role for permitted actions. Pairing an Agent does not create a Manager account. Follow the Gateway's existing registration and verification flow; do not assume an `admin` account exists.
3. A simple username such as `admin` only uses the legacy Manager bootstrap path when the **Gateway** is explicitly in `NODE_ENV=development` or `NODE_ENV=test`, `ALLOW_LEGACY_MANAGER_AUTH=1`, and configured bootstrap credentials/tenant match. That pathway is deliberately unavailable in production. Do not enable it just to work around a login problem.
4. A failed login now shows an error. A missing Gateway configuration also produces an actionable warning instead of leaving the submit button silently disabled. Passwords are not logged or persisted by the Desktop form.
5. If correct production credentials receive `401`, verify account membership and email verification; for `503`, verify the Gateway host-to-tenant mapping/database and rate-limit backing store. Check redacted Gateway logs with the request ID. Native Desktop sign-in additionally requires the Rust proxy to obtain credentials, store them outside JavaScript, and pass the follow-up `/api/auth/manager/me` proof. This flow requires native Windows testing.

## Windows printer discovery and capture testing

1. On the target computer, install the printer and ensure the appropriate Windows account can see it. Click **Printers > Discover**. The **Local virtual printer queues** panel displays detected PDF/XPS/OneNote/software or redirected queues as *local diagnostic inventory only*; physical-capable queues remain separately managed.
2. The revised Desktop launches the matching revised Agent CLI with `printers discover --json --include-virtual`. The CLI obtains installed queues with `EnumPrintersW` and related metadata; it does not persist diagnostic software queues as Agent or Gateway print destinations. Run the revised CLI interactively as the user whose Windows queues you want to inspect. A Session-0 Windows service may have a different printer inventory and credentials.
3. To test **actual Gateway > Agent job reception** without paper, use the explicitly enabled **Yaseir Virtual Test Printer** *file-capture* sink documented in [`VIRTUAL_PRINTER_TESTING.md`](VIRTUAL_PRINTER_TESTING.md). This capture is separate from arbitrary installed Windows PDF/XPS queues. Configure opt-in flags on a disposable test installation, trigger an authorized Manager test job, inspect its job identity and captured bytes, and turn the flags off when finished.
4. **Not supported as automatic production destinations:** Microsoft Print to PDF, XPS, OneNote, vendor fax software, redirected RDP queues, and arbitrary software writers. They may require a Save As dialog, an interactive session, or a third-party driver; their mere discovery does not prove a Windows service can send to them. Confirm vendor-specific unattended printing independently if required.

## On-site checks: record observed results, do not pre-fill PASS

- Target Windows build, operator/service-account SID, Agent/CLI/installer hashes, Gateway release, printer/driver versions, and exact queue name.
- Verify Manager login (verified email), rejected password, missing Gateway URL and `Check Connection` on narrow/RTL and regular screens; confirm a failed probe preserves saved configuration.
- Discover installed virtual queue(s) under interactive Desktop session, check names and ports, and confirm they are **not** exposed as Gateway production destinations.
- Trigger file-capture Manager test job with a known PDF and inspect bytes, job state, claim/attempt IDs, and status; distinguish capture from physical paper.
- Separately validate actual physical/driver paths on the target equipment: 58/80 mm Arabic/English POS receipt and intentional reprint; kitchen/bar two-station partial failure, unknown response, safe retry; multi-page invoice PDF through Windows spooler and IPP where supported; RAW/ESC-POS and USB where supported by model. Test offline/paper-out, driver errors, reconnect, service restart and duplicate click. Record evidence as `PASS`, `FAIL`, or `NOT_RUN` with operator/date.

## Deployment / rollback

Build Gateway, Agent CLI/service and Tauri Desktop from the *same* source revision and the locked dependencies with the versions declared in `package.json`, `agent/go.mod`, and `src-tauri/Cargo.lock`; otherwise the new Desktop discovery contract will not be available. Back up existing Agent configuration, registry and SQLite state, and Gateway database using existing supported maintenance procedures before upgrading. Preserve pairing secrets and user data; do not overwrite them with test credentials. Roll back all three binaries as one compatible set if the new discovery contract or Manager proxy cannot be verified. Never delete the Agent's local queue database to force a retry; pending/ambiguous job evidence must be reconciled first.
