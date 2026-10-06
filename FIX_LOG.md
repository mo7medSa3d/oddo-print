RESUME HERE: PHASE 3 / final production audit | fixed Agent/Gateway connection aliases, manual registry validation, USB protocol parity and diagnostic injection | run final contradiction sweep and require latest-head workflows green | blockers: none

# FIX LOG

## 2026-10-06 final production audit

- Production session cookies are now unconditionally Secure when NODE_ENV=production; COOKIE_SECURE=0 is development-only.
- Added regression coverage for the production Secure-cookie invariant.
- Repaired stale printer-model alias fixture so the unit suite exercises the current canonical printer schema rather than weakening that schema.
- Hardened the Windows desktop Manager data root and settings/log files: protected DACL, Administrators ownership, SYSTEM/Administrators full control, standard Users read-only, direct System32 icacls resolution, and reparse-point refusal.
- Added Windows installer smoke coverage for the Manager data ACL/owner invariant.
- Made generic, manager, and platform logout handlers clear browser cookies even when database-backed session validation is unavailable; server-side revocation failure is still surfaced as HTTP 503.
- Added regression coverage for logout cookie clearing during session-store failure.
- Security/CodeQL/supply-chain gates were green on the intermediate heads checked. Final workflow verification must be performed against the final head after this audit batch.


- Completed route-level authorization inventory for all 76 `src/app/api/**/route.ts` handlers; authenticated resource routes are scoped through manager/agent/Odoo/platform boundaries, while intentionally public token/webhook/health routes use token/signature/rate-limit controls.
- Fixed heartbeat canonicalization so modern `connectionType=tcp` and `connectionType=windows_spooler` inputs converge to Gateway `network` / `spooler` rather than being silently skipped.
- Added PostgreSQL-backed heartbeat regression coverage for both aliases.
- Hardened `RegisterManual()` so CLI/manual printers cannot be persisted with a transport/protocol contract the Agent runtime validator rejects; added Go regressions for aliases, invalid combinations, and USB-spooler normalization.
- Repaired the Windows Rust logger test harness after the ACL API expansion; production ACL behavior remains unchanged.


- Cross-layer payload/runtime parity review found direct USB ZPL/TSPL was admitted by Agent config + Gateway capability logic but rejected by the Agent USB factory. Factory and both USB build-target capability surfaces now support validated ZPL/TSPL byte streams.
- Local Windows USB diagnostic ticket generation is now protocol-aware for ESC/POS, ZPL, TSPL and generic RAW.
- Added printer-language injection hardening for user/operator-controlled printer names embedded in local ZPL/TSPL diagnostic tickets.

## Next exact task

Complete the route-by-route authorization audit for the remaining platform/print/printer/settings/system/team surfaces, inspect any suspicious exception/logging paths, repair confirmed defects, then require the final main head workflows to be green or record exact blockers.
