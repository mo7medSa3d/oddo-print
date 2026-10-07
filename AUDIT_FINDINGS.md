# AUDIT FINDINGS

## DEP-001

- **ID:** DEP-001
- **Severity:** P1
- **Subsystem:** Gateway / web dependency supply chain
- **File/location:** `package.json`, `package-lock.json`
- **Problem:** Production is pinned to Next.js 16.3.6 while the repository's Dependabot security update PR #122 moves to 16.3.8 and identifies a high-severity SSRF fix (GHSA-cjq9-62q9-8jv4), along with additional medium/low security fixes.
- **Root cause:** Security patch release is available but has not been integrated into `main`.
- **Affected flows:** Next.js request/rendering/image optimization surface; production web Gateway.
- **Fix strategy:** Apply the focused 16.3.8 Next.js + matching eslint-config-next lockfile update from the repository's Dependabot security PR, then run the full Node test/typecheck/lint/build and security gates via PR CI.
- **Status:** CONFIRMED — repair in progress.

## Verification note — current main CodeQL

- Latest Static Security Gates run failed in all CodeQL language jobs because GitHub improved incremental analysis/cache did not complete successfully after analysis and SARIF generation.
- Secret Scan passed.
- Do not interpret this infrastructure/cache failure as a code-security pass or as a detected application vulnerability. Re-run through the audit PR and record the actual result.
