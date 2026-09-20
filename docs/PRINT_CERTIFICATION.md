# Real Print Certification Mode

## Purpose
Prove E2E printing before client demo: Gateway → Auth → Queue → Claim → Agent → Transport → Physical → Ack → Final.

## Wizard Steps
1. **Gateway**: Gateway reachable, X-Request-Id minted
2. **Auth**: Tenant owns printer, printer active, agent active
3. **Queue**: Job enqueued with idempotency, expiresAt, payload YASSER TEST PAGE (no secrets)
4. **Claim**: Agent claim fencing via advisory lock + claim_token, check agent ONLINE (lastSeen <90s)
5. **Agent**: Agent online, heartbeat fresh
6. **Transport**: Transport selected (network/usb/spooler/ipp/ipps) + Protocol (raw/escpos/zpl/tspl/ipp/spooler) with capability matrix
7. **Physical**: Paper verification — BLOCKED in sandbox, requires real printer hardware. Must verify YASSER TEST PAGE physically printed.
8. **Ack**: Agent ack success via PATCH /api/agent/jobs with spoolerJobId linking
9. **Final**: Certification complete, timeline URL, correlation IDs

## API
`POST /api/printers/[id]/certify`
- Body: { testPage?: boolean, documentType?: string }
- Creates real job `cert_<nanoid>` with payload YASSER TEST PAGE base64
- Records job_events: created, queued, blocked (physical)
- Returns: printerId, jobId, requestId, attemptId, steps[], capability, certified (false until physical), blocked, blockedReasons, instructions, timelineUrl

## UI
`PrintCertificationWizard` component:
- Button "Run Certification"
- Shows steps with status ok/error/blocked/pending/running, timestamps, evidence
- Shows correlation IDs
- Links to timeline JSON
- BLOCKED handling note

## Timeline
`GET /api/jobs/[id]/timeline` returns timeline derived from job_events or from job row if events missing.

## Spooler Linking
When using spooler transport, agent should report spoolerJobId via PATCH body. Gateway persists to print_jobs.spooler_job_id and job_events.spooler_job_id. This links Gateway Job ↔ Windows Spooler Job ID for diagnostics.

## BLOCKED Handling
In sandbox without physical printer, Physical step is BLOCKED by design. Certification returns certified=false, blocked=true, blockedReasons=[{step: physical}]. On real hardware:
1. Ensure agent online
2. Ensure printer reachable
3. Check spoolerJobId linking
4. Verify physical paper output YASSER TEST PAGE
5. Confirm ack success

## Test Page Content
```
YASSER TEST PAGE
Printer: <name>
Tenant: <tenantId>
Job: <jobId>
Request: <requestId>
Time: <ISO>
Transport: <connectionType>/<protocol>

This is a diagnostic test page for certification.
No secrets are printed.
```

## Future
- Diagnostic Test Page endpoint already exists: POST /api/printers/[id]/test-print
- Per-printer concurrency 1 default (P1)
- Driver Health Check (P1)
- RAW vs Spooler/IPP distinction with Win32 regression suite (P1)
