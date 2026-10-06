RESUME HERE: PHASE 3 / final production audit | fixed production Secure-cookie override, stale printer alias fixture, Manager ProgramData ACL tampering risk, logout cookie-clearing outage path | continue exhaustive API/authz and sensitive-boundary negative audit; then verify latest main workflows | blockers: none

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

## Next exact task

Complete the route-by-route authorization audit for the remaining platform/print/printer/settings/system/team surfaces, inspect any suspicious exception/logging paths, repair confirmed defects, then require the final main head workflows to be green or record exact blockers.
