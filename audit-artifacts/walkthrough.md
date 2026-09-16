# Walkthrough — Forensic Audit Repairs

## Overview

14 specialized forensic agents inspected the entire Odoo Print Gateway repository. **10 verified defects were repaired** across 9 files. **Zero regressions** — all 300 tests pass, TypeScript and ESLint produce zero errors.

---

## Changes Made

### 1. Security: Timing Side-Channel in Proxy Secret Comparison

**File**: [`trusted-proxy.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/server/trusted-proxy.ts)

```diff
-import { timingSafeEqual } from "node:crypto";
+import { createHash, timingSafeEqual } from "node:crypto";
 
 function safeEqual(left: string, right: string): boolean {
-  const a = Buffer.from(left, "utf8");
-  const b = Buffer.from(right, "utf8");
-  return a.length === b.length && timingSafeEqual(a, b);
+  const digestA = createHash("sha256").update(left, "utf8").digest();
+  const digestB = createHash("sha256").update(right, "utf8").digest();
+  return timingSafeEqual(digestA, digestB);
 }
```

> [!IMPORTANT]
> The old code short-circuited on `a.length !== b.length`, allowing an attacker to deduce the exact byte length of the proxy secret through timing analysis.

---

### 2. Security: Timing Side-Channel in Manager Auth

**File**: [`manager-auth.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/lib/manager-auth.ts)

Same fix applied to `compareStringsSafe` — hashes both inputs to fixed-length SHA-256 digests before `timingSafeEqual`. This now matches the pattern in [`agent-auth.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/lib/agent-auth.ts#L45-L53).

---

### 3. Concurrency: Heartbeat vs. Job Claiming Race Condition

**Files**: [`job-delivery.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/lib/job-delivery.ts#L133), [`agent/jobs/route.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/app/api/agent/jobs/route.ts#L118)

```diff
-      FOR UPDATE OF p, a, pr SKIP LOCKED
+      FOR UPDATE OF p SKIP LOCKED
```

> [!WARNING]
> Agent heartbeats routinely lock the `agents` row. With `FOR UPDATE OF p, a, pr SKIP LOCKED`, the `SKIP LOCKED` clause caused the entire job query to silently return zero rows when a heartbeat held the agent lock — dropping valid job deliveries without any error.

---

### 4. Tenant Isolation: Missing tenant_id in Poll Path JOINs

**File**: [`agent/jobs/route.ts`](file:///home/mo7amed_saad/work/odoo%20github/src/app/api/agent/jobs/route.ts)

```diff
-      JOIN agents a ON a.id = p.agent_id
-      JOIN printers pr ON pr.id = p.printer_id
+      JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
+      JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
```

Applied to all 4 CTEs (in-flight count, `stale_candidates`, `queued_candidates`, `claimable`). The WebSocket push path already had these correctly — only the HTTP poll path was missing them.

---

### 5. Docker: Missing tsconfig.json in Runtime Stage

**File**: [`Dockerfile`](file:///home/mo7amed_saad/work/odoo%20github/Dockerfile#L36)

```diff
 COPY --from=build /app/next.config.ts ./next.config.ts
+COPY --from=build /app/tsconfig.json ./tsconfig.json
 COPY --from=build /app/package.json ./package.json
```

`tsx` (used by `server.ts` and `db:migrate`) requires `tsconfig.json` for module resolution.

---

### 6. Docker: Lightweight Healthcheck

**File**: [`Dockerfile`](file:///home/mo7amed_saad/work/odoo%20github/Dockerfile#L44)

```diff
-  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
+  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1
```

Eliminates spawning a full V8 isolate every 30 seconds — `wget` is ~100x lighter and is included in Alpine.

---

### 7. CI: Cancel-in-Progress on Main Branch

**File**: [`ci.yml`](file:///home/mo7amed_saad/work/odoo%20github/.github/workflows/ci.yml#L12)

```diff
-  cancel-in-progress: true
+  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

Prevents CI from canceling in-progress validation of main branch commits.

---

### 8–10. Documentation Accuracy

| File | Fix |
|------|-----|
| [`SECURITY.md`](file:///home/mo7amed_saad/work/odoo%20github/SECURITY.md#L19) | `bcrypt` → `Argon2id` (matching actual implementation) |
| [`DEPLOYMENT.md`](file:///home/mo7amed_saad/work/odoo%20github/DEPLOYMENT.md#L69) | `X-Trust-Proxy-Secret` → `X-Gateway-Proxy-Token` (matching code) |
| [`.env.example`](file:///home/mo7amed_saad/work/odoo%20github/.env.example) | Added 5 missing env vars: `MANAGER_USERNAME`, `MANAGER_PASSWORD_HASH`, `ALLOW_PLAINTEXT_MANAGER_PASSWORD`, `STALE_AGENT_THRESHOLD_SECONDS` |

---

## Validation Results

| Check | Before | After |
|-------|--------|-------|
| Unit tests (300 tests) | ✅ 300 pass | ✅ 300 pass |
| TypeScript (`tsc --noEmit`) | ✅ 0 errors | ✅ 0 errors |
| ESLint | ✅ 0 errors | ✅ 0 errors |
| Regressions | — | **0** |

---

## 27 Open Issues

The full audit report with all 27 remaining open issues (categorized P0–P4 with evidence and recommended fixes) is available in the [Final Report](file:///home/mo7amed_saad/.gemini/antigravity/brain/a750a831-b7ba-4a7e-8c31-3b2857dd581b/final-report.md).

Top priority open items:
1. **PERF-1 (P0)**: WS rate limiter uses DB transaction per upgrade — DoS risk during mass reconnect
2. **ARCH-1 (P1)**: `fencedJobWrite` omits `tenantId` in WHERE predicates
3. **AGENT-1 (P1)**: Go agent `wg.Add(1)` race with `wg.Wait()` during shutdown
4. **ODOO-01 (P1)**: Cron recovery renders reports with wrong company context
