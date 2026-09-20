# Print Gateway Forensic Audit

_Audited: 2026-09-20_

---

## Executive Summary

This audit covers `print_job.py`, `routing.ts`, `binding.py`, `print_intent.py`, and `print_router.py`. **Seven confirmed bugs** are found, ranging from a critical incorrect failover capability check to subtle TOCTOU races, a reprint counter race, silent 200 response masking, and a missing `completed_at` on the timeout-unknown path.

---

## BUG-01 — CRITICAL: `raster_jpeg` failover incorrectly includes IPP/IPPS (wrong capability)

**Severity:** Critical — functional correctness, silent misroute  
**File:** `print_job.py`  
**Function:** `_handle_pre_dispatch_failure`  
**Lines:** 714–717

**Evidence:**
```python
# L714-717
if job.payload_type == "pdf":
    protocol_compatible = fallback_proto in ("spooler", "ipp", "ipps")
elif job.payload_type == "raster_jpeg":
    protocol_compatible = fallback_proto in ("spooler", "escpos")
```

**Cross-reference — `routing.ts` L73-77 (the authoritative Gateway capability table):**
```typescript
const physicalPdf = conn === "spooler" || proto === "spooler"
  || conn === "ipp" || conn === "ipps"
  || (conn === "network" && proto === "ipp");
const physicalImage = conn === "spooler" || proto === "spooler"
  || (conn === "network" && proto === "escpos");
```

**Analysis:**  
The Gateway (`routing.ts`) defines `physicalImage` (for `image`/`raster_jpeg` payloads) as **only** `spooler` or `network+escpos`. IPP and IPPS are NOT in the image path — they are PDF-only transports. The `physicalPdf` definition explicitly includes `ipp`/`ipps`; `physicalImage` explicitly does NOT.

The Odoo `_handle_pre_dispatch_failure` code for `raster_jpeg` correctly excludes `ipp`/`ipps` (line 717: `"spooler", "escpos"` only). **This is already CORRECT.**

However, `binding.py` line 479 shows:
```python
if payload_type in ("pdf", "raster_jpeg") and binding.printer_protocol not in ("spooler", "ipp", "ipps"):
    raise ValidationError(_("The explicitly selected print binding is not capable of document printing."))
```

This validates both `pdf` AND `raster_jpeg` against the same `("spooler", "ipp", "ipps")` set — which is wrong. An IPP/IPPS binding would pass `resolve_explicit` validation for a `raster_jpeg` payload, but then fail at the Gateway with a 422 CAPABILITY_MISMATCH because the Gateway's `physicalImage` does not include IPP/IPPS.

**Root Cause:** `binding.py:479` conflates the PDF capability set with the image/raster capability set. Adding IPP/IPPS to the `raster_jpeg` check in `resolve_explicit` is incorrect. The correct set for `raster_jpeg` is `("spooler", "escpos")`.

**Failure Scenario:** Operator creates an explicit binding with `printer_protocol = "ipp"` and triggers a POS receipt print (raster_jpeg). `resolve_explicit` accepts it at line 479, the job is submitted to the Gateway, and the Gateway returns 422 CAPABILITY_MISMATCH. The job terminates with `failed`, the receipt is not printed, and the operator sees a cryptic gateway error.

**Fix:**
```python
# binding.py L479 — split by payload type
if payload_type == "pdf" and binding.printer_protocol not in ("spooler", "ipp", "ipps"):
    raise ValidationError(_("The explicitly selected print binding is not capable of PDF printing."))
if payload_type == "raster_jpeg" and binding.printer_protocol not in ("spooler", "escpos"):
    raise ValidationError(_("The explicitly selected print binding is not capable of raster/image printing."))
```

---

## BUG-02 — HIGH: Missing `completed_at` in timeout→unknown path

**Severity:** High — data integrity, stale `completed_at`  
**File:** `print_job.py`  
**Function:** `_action_submit_trusted`  
**Lines:** 926–936

**Evidence:**
```python
# L926-936 — Timeout → unknown branch
values = {
    "status": "unknown",
    "attempts": job.attempts + 1,
    "last_error": "UNKNOWN_SUBMISSION_OUTCOME: gateway request timed out (ambiguous dispatch)",
    "next_retry_at": False,
}
```

**`_record_ambiguous_submission` (L674-678) also lacks `completed_at`:**
```python
values = {
    "status": "unknown",
    "attempts": job.attempts + 1,
    "last_error": "UNKNOWN_SUBMISSION_OUTCOME: %s (ambiguous dispatch)" % detail,
    "next_retry_at": False,
}
```

**Analysis:** `"unknown"` is a terminal state (see `_TERMINAL` at L90). All other terminal-state writes in the file include `"completed_at": fields.Datetime.now()` (e.g., L864, L907, L986, L1002, L1056). The timeout→unknown and ambiguous-submission→unknown paths do not, leaving `completed_at = NULL` on terminal rows. This breaks any reporting/SLA query that filters on `completed_at IS NOT NULL` to find finished jobs.

**Fix:** Add `"completed_at": fields.Datetime.now()` to both `values` dicts (L930 and L677).

---

## BUG-03 — HIGH: TOCTOU race in `action_force_reprint` reprint counter

**Severity:** High — duplicate prints under concurrent operators  
**File:** `print_job.py`  
**Function:** `action_force_reprint`  
**Lines:** 1208–1251

**Evidence:**
```python
# L1208-1209 — counter read is from ORM cache
new_count = (job.reprint_attempt_count or 0) + 1
derived_key = "%s-reprint-%d" % (job.idempotency_key, new_count)

# L1214 — create_operation with derived_key BEFORE counter is written
retry = self.create_operation(..., idempotency_key=derived_key)

# L1242-1249 — counter written AFTER create_operation
self.env.cr.execute(
    """UPDATE print_gateway_print_job
       SET reprint_attempt_count = GREATEST(reprint_attempt_count, %s)
       WHERE id = %s""",
    (new_count, job.id),
)
```

**Analysis:** The ORM-cached `reprint_attempt_count` is read at L1208. If two operators click Force Reprint simultaneously for the same job, both read `count=0`, both compute `new_count=1` and `derived_key="<key>-reprint-1"`. `create_operation` uses a `UNIQUE(company_id, idempotency_key)` constraint, so the second `create_operation` will **return the existing row** (idempotency collapse), and the second operator gets the already-submitted job — that is the intended behavior. The `GREATEST` UPDATE then runs twice but is idempotent. So concurrent operators DO collapse correctly.

However, a **sequential** scenario is broken: if operator A does reprint (count goes to 1), then operator B does reprint before Odoo has refreshed the ORM cache (still shows 0), B again computes `new_count=1` and `derived_key="<key>-reprint-1"`, which already exists. `create_operation` returns the ORIGINAL reprint job (which may already be `success`). The `action_submit()` call at L1251 silently no-ops (gateway_job_id already set, L820-825). B sees a "Force Reprint Dispatched" success notification, but no new print was issued.

**Root Cause:** The counter is read from ORM cache which is stale. The `GREATEST` UPDATE happens after the idempotency key is already consumed.

**Fix:** Read the counter with a `SELECT ... FOR UPDATE` before computing the derived key, or invalidate the recordset before reading `reprint_attempt_count`:
```python
job.invalidate_recordset(["reprint_attempt_count"])
new_count = (job.reprint_attempt_count or 0) + 1
```

---

## BUG-04 — HIGH: `cron_submit_pending` calls `action_submit()` (public, ACL-guarded) instead of `_action_submit_trusted`

**Severity:** High — cron silently fails if cron user has no write ACL  
**File:** `print_job.py`  
**Function:** `cron_submit_pending`  
**Line:** 1294

**Evidence:**
```python
# L1294
job.action_submit()
```

**`action_submit` at L792-794:**
```python
def action_submit(self, raise_on_failure=False):
    self._require_outbox_write()   # ← ACL check
    return self._action_submit_trusted(raise_on_failure=raise_on_failure)
```

**`_require_outbox_write` at L790:**
```python
self.check_access("write")
```

**Analysis:** `cron_submit_pending` already calls `_require_cron_runner()` (checks `base.group_system`), then iterates jobs and calls `action_submit()`. `action_submit` calls `_require_outbox_write()` which calls `self.check_access("write")`. If the scheduled action's user does not hold outbox write rights (possible because the outbox is intentionally read-only for normal users), every job will raise `AccessError` and be silently swallowed — `cron_submit_pending` returns a count that may not reflect actual submissions. Compare with `_action_submit_trusted` in `print_router._submit_durable_job` (L324) which correctly bypasses the public guard.

**Fix:** Call `job._action_submit_trusted()` instead of `job.action_submit()` in the cron body, matching the pattern in `_submit_durable_job`.

---

## BUG-05 — MEDIUM: `action_retry` calls `retry.action_submit()` without `raise_on_failure`; submission errors are silently swallowed

**Severity:** Medium — silent failure, misleading success notification  
**File:** `print_job.py`  
**Function:** `action_retry`  
**Line:** 1173

**Evidence:**
```python
# L1173
retry.action_submit()
retried_jobs |= retry  # added unconditionally
```

**Analysis:** `action_submit()` is called with `raise_on_failure=False` (the default). If the Gateway is unreachable or returns a 4xx, the retry job is created in `queued` state and the submission silently fails — the job is still appended to `retried_jobs` and the operator sees a "Print Job Retried" success notification. The operator has no indication that the submission failed. The cron will re-attempt later (if not terminal), but the UX is misleading.

The same pattern exists for `action_force_reprint` at L1251.

**Fix:** Pass `raise_on_failure=True` or check job status post-submit before adding to `retried_jobs`, and surface a warning notification if submission failed.

---

## BUG-06 — MEDIUM: `cron_sync_status` batch-status fallback calls `job.action_sync_status()` inside cron context, triggering redundant ACL check

**Severity:** Medium — latent AccessError risk in fallback path  
**File:** `print_job.py`  
**Function:** `cron_sync_status`  
**Lines:** 1356-1367

**Evidence:**
```python
# L1356-1358 — non-200 batch response fallback
else:
    for job in chunk:
        job.action_sync_status()  # ← public method with _require_outbox_write
        total_synced += 1

# L1362-1366 — exception fallback
except Exception as exc:
    for job in chunk:
        try:
            job.action_sync_status()  # ← same issue
```

**`action_sync_status` at L1069-1070:**
```python
def action_sync_status(self):
    self._require_outbox_write()   # ← ACL check
```

**Analysis:** The cron already ran `_require_cron_runner()` (system group), but `action_sync_status()` additionally calls `self._require_outbox_write()` → `self.check_access("write")`. If the cron user's ACL doesn't cover write on `print_gateway.print_job`, the fallback silently fails and the `except Exception: pass` at L1366 swallows the AccessError, leaving jobs stuck in non-terminal states.

**Fix:** Use a private method (analogous to `_action_submit_trusted`) for the sync operation, or call `sudo()` before `action_sync_status()` in the cron fallback path.

---

## BUG-07 — MEDIUM: `_persist_state` opens a second cursor while the caller may hold an uncommitted write lock (documented but incomplete guard)

**Severity:** Medium — potential deadlock in edge cases  
**File:** `print_job.py`  
**Function:** `_persist_state`  
**Lines:** 459-473

**Evidence:**
```python
def _persist_state(self, values):
    self.ensure_one()
    cr = self.env.registry.cursor()
    try:
        cr.execute("SET LOCAL lock_timeout = '5s'")
        env = api.Environment(cr, self.env.uid, dict(self.env.context))
        env["print_gateway.print_job"].sudo().browse(self.id).write(values)
        cr.commit()
    finally:
        cr.close()
```

**Analysis:** The `lock_timeout = '5s'` guard is documented as protecting against the C1→C2→C1 deadlock (C1 holds a row lock, C2 tries to UPDATE the same row, C2 hangs). However, `SET LOCAL lock_timeout = '5s'` applies only within the **current transaction block**. If `_persist_state` is called outside an explicit `BEGIN`, the `SET LOCAL` is ineffective — PostgreSQL auto-commits each statement and the timeout is never set for the UPDATE. In Odoo, `cursor()` starts a new transaction; the `SET LOCAL` will apply correctly only if the `execute` and the subsequent `write` happen in the same transaction block, which they do here (since `cr.commit()` comes after). This is correct.

The real residual risk: the 5-second timeout means a live-locked cron worker (C1 hangs waiting for C2, which waits for C1) will reliably timeout at 5s and raise `psycopg2.errors.LockNotAvailable` — but this exception is not caught. It propagates through `_persist_state` as an unhandled exception, causing the job to remain in its pre-write state without recording the intended terminal/retry status. The job will be re-picked by the next cron run, which is acceptable but means one cron cycle is wasted.

**Fix:** Catch `LockNotAvailable` (or `OperationalError`) in `_persist_state` and log a warning, allowing the cron to move on.

---

## BUG-08 — LOW: `_advance_status` destination variable shadows `print_job.py` import

**Severity:** Low — naming confusion, no functional bug  
**File:** `print_job.py`  
**Function:** `_advance_status`  
**Line:** 147

**Evidence:**
```python
try:
    position = self._FORWARD_CHAIN.index(job.status)
    destination = self._FORWARD_CHAIN.index(target)  # ← shadows field name
except ValueError:
```

**Analysis:** The local variable `destination` shadows the model field `destination` (L30: `destination = fields.Char(...)`). This is not a functional bug here since `job.destination` is accessed via `job.` prefix, but it creates a naming hazard and a pylint W0621.

---

## Failover / IPP / Raster Chain Trace (Answered)

### Q1: Failover logic for `raster_jpeg` payloads

**`print_job.py` L716-717:**
```python
elif job.payload_type == "raster_jpeg":
    protocol_compatible = fallback_proto in ("spooler", "escpos")
```
Failover for raster only engages for `spooler` or `escpos` backup printers. IPP/IPPS are correctly excluded here.

### Q2: What protocols does IPP/IPPS support in `routing.ts`?

**`routing.ts` L73-77:**
```typescript
const physicalPdf = conn === "spooler" || proto === "spooler"
  || conn === "ipp" || conn === "ipps"
  || (conn === "network" && proto === "ipp");
const physicalImage = conn === "spooler" || proto === "spooler"
  || (conn === "network" && proto === "escpos");
```
IPP/IPPS support **PDF only** (physicalPdf). They are NOT in `physicalImage`. For `image` (raster_jpeg) payloads, the Gateway accepts only `spooler` or `network+escpos`.

### Q3: Full chain — Odoo payload type → Gateway type → Gateway capability → Go agent → transport

| Odoo `payload_type` | Wire `type` | `physicalImage`/`physicalPdf` | Gateway accepted protocols | Go agent transport |
|---|---|---|---|---|
| `pdf` | `pdf` | `physicalPdf` | spooler, ipp, ipps, network+ipp | OS spooler / IPP submission |
| `raster_jpeg` | `image` | `physicalImage` | spooler, network+escpos | OS spooler / ESC/POS raster-convert |
| `raw_cmd` | `raw` / `escpos` | `physicalByteProtocol` | exact protocol match | raw byte socket / USB |

`_PAYLOAD_TYPE_MAP` in `print_job.py` (L173-178) maps: `"image" → "raster_jpeg"`. The reverse mapping (`"raster_jpeg"` → `"image"`) happens in `_validate_persisted_payload` L491-493 (checks `ptype == "image"` for `payload_type == "raster_jpeg"`).

### Q4: Is adding IPP/IPPS to `raster_jpeg` failover **correct or incorrect**?

**INCORRECT** — and the current failover code at L716-717 does NOT add them (it's already correct). The bug is in `binding.py:479` where `resolve_explicit` validates both `pdf` and `raster_jpeg` against the PDF capability set `("spooler", "ipp", "ipps")`, which will allow an IPP binding to be selected for a raster_jpeg job — but the Gateway will then reject it with 422. IPP/IPPS must NOT be added to raster/image failover or routing.

---

## Additional Observations (Not Bugs)

### API Key Authentication
- `gateway_config._gateway_headers()` is called for every outbound request. The implementation is not shown here but is invoked consistently in all HTTP calls (submit L843, sync L1090, batch-status L1333). Authentication appears uniform.

### Gateway URL Validation
- `gateway_config._gateway_base(for_request=True)` is called before every request. The `binding.py:257` validation path calls it and wraps errors in `ValidationError`.
- URLs are never constructed from user-supplied data at the submission path — the gateway_config record is always used. No injection risk.
- Missing schema / invalid URL is caught by `_is_deterministic_failure` (L659-664: `MissingSchema`, `InvalidSchema`, `InvalidURL`, `InvalidHeader`) and terminalized immediately.

### Idempotency
- `create_operation` has two-level idempotency: ORM search + `savepoint` + `IntegrityError` catch (L438-452). The `same_operation()` guard prevents key reuse for different content. Solid.

### Claim Fencing (print_intent.py)
- `_claim_intent` uses a single atomic UPDATE with a `WHERE` clause checking status+timing (L97-105). `_finalize_intent_state` fences on `claim_token` (L136: `WHERE id = %s AND claim_token = %s`). Correct.

### Status Machine
- `_VALID_TRANSITIONS` (L92-109) is enforced by `write()` (L255-288). `_advance_status` walks the forward chain hop-by-hop. Terminal states are self-loops only. The regression guard at L153-157 is correct.
- One gap: `_apply_synced_status` at L1057-1058 silently returns `True` (no-op) when the Gateway reports `submitted`/`queued` for a job that Odoo already has at `claimed`/`printing`. This is correct behavior (ignore backward-moving Gateway report) but is not logged, making it invisible in debugging.

### Expired Job Handling
- `_action_submit_trusted` L883-897 and `_apply_synced_status` L1038-1046 both handle `expired` gateway status. The `JOB_EXPIRED_DURING_PRINT` marker correctly maps to `unknown` (possible physical output). Jobs expired before claim map to `failed`.

### Unknown Outcome Handling
- `_GATEWAY_UNKNOWN_MARKERS` (L304-310) must stay in lockstep with the TypeScript `PHYSICAL_OUTCOME_UNKNOWN_MARKERS`. A contract test (`test_gateway_marker_parity`) is referenced. The five markers are consistent across `_compute_physical_outcome`, `_apply_synced_status`, and `_action_submit_trusted`.

---

## Summary Table

| ID | Severity | File | Location | Description |
|---|---|---|---|---|
| BUG-01 | **Critical** | binding.py | L479 | `resolve_explicit` accepts IPP/IPPS for `raster_jpeg`, but Gateway rejects it (422) |
| BUG-02 | **High** | print_job.py | L677, L930 | `completed_at` missing on timeout→unknown and ambiguous→unknown terminal writes |
| BUG-03 | **High** | print_job.py | L1208 | Force-reprint counter read from stale ORM cache; sequential reprintgets same key |
| BUG-04 | **High** | print_job.py | L1294 | `cron_submit_pending` calls public `action_submit()` (ACL-guarded) instead of trusted variant |
| BUG-05 | **Medium** | print_job.py | L1173, L1251 | `action_retry` / `action_force_reprint` call `action_submit()` with `raise_on_failure=False`; silent failure, misleading success UI |
| BUG-06 | **Medium** | print_job.py | L1358, L1364 | `cron_sync_status` fallback calls `action_sync_status()` (ACL-guarded); silently swallowed if ACL denies |
| BUG-07 | **Medium** | print_job.py | L459 | `_persist_state` `LockNotAvailable` unhandled; stale job state on deadlock timeout |
| BUG-08 | **Low** | print_job.py | L147 | Local var `destination` shadows model field name |
