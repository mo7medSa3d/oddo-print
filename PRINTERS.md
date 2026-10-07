# Printers — backends, payload semantics, discovery

Source: `agent/internal/printer/*.go`, `src/lib/routing.ts`, `src/lib/payload.ts`.

Verification labels used below:
**VERIFIED** = executed in this repository's automated tests ·
**COMPILE VERIFIED** = builds and vets for the target platform but was never executed ·
**SIMULATED** = a non-Windows development stand-in ·
**NOT VERIFIED** = requires hardware nobody has exercised here.

## 1. Payload types

The job payload is one of four Gateway wire kinds (`raw`, `escpos`, `pdf`, `image`).
`zpl` and `tspl` are printer-native protocols carried inside the `raw` wire kind rather than separate Gateway payload kinds (`agent/internal/printer/document.go`, `contracts/print-payload-contract.json`):

| type | meaning | agent path |
|---|---|---|
| `raw` | opaque printer-native byte stream | written verbatim to the transport |
| `escpos` | ESC/POS command stream (`ESC @` init … `GS V` cut) | written verbatim to the transport (ESC/POS is a payload dialect, not a transport) |
| `pdf` | a real PDF document | PDF pipeline: validate → secure temp file → PDF-aware submission → wait → delete temp file |
| `image` | JPEG raster payload | rasterized per backend; ESC/POS network printers convert JPEG to ESC/POS, spooler converts JPEG to PDF |

**A PDF is never converted into RAW printer bytes, never renamed, and never "assumed
supported because the printer accepts raw".** Sending PDF bytes to an ESC/POS byte-stream
printer produces pages of garbage, so it is refused with `CAPABILITY_MISMATCH`.

## 2. Backend / payload matrix

| Backend | Implementation | `raw` | `escpos` | `pdf` | Physical verification |
|---|---|---|---|---|---|
| Network RAW TCP (:9100) | `network.go` | ✅ | ✅ | ❌ `CAPABILITY_MISMATCH` (a 9100 byte stream has no renderer) | **NOT VERIFIED** (tested against a local mock listener — VERIFIED at socket level) |
| Windows spooler | `spooler_windows.go` | ⚠️ only when RAW passthrough is explicitly declared | ⚠️ only when ESC/POS passthrough is explicitly declared | ✅ PDF pipeline (§4) | **COMPILE VERIFIED** only |
| Windows spooler (non-Windows build) | `spooler_stub.go` | `ERR_UNSUPPORTED_TRANSPORT` (simulated file write only under explicit opt-in, still reported as failure) | same | `ERR_UNSUPPORTED_TRANSPORT` (same opt-in rule) | **SIMULATED** |
| IPP / IPPS | `ipp.go` | ❌ `CAPABILITY_MISMATCH` (IPP is a document transport here) | ❌ `CAPABILITY_MISMATCH` | ✅ `application/pdf` | **NOT VERIFIED** against a real IPP printer (`httptest` coverage only) |
| USB raw (`CreateFile` + `WriteFile`) | `usb_windows.go` | ✅ only for an explicitly declared `raw` device | ✅ only for an explicitly declared `escpos` device | ❌ `CAPABILITY_MISMATCH` — install the device as a Windows printer and route to the spooler queue | **COMPILE VERIFIED** only |
| USB raw (non-Windows build) | `usb_other.go` | `ERR_UNSUPPORTED_TRANSPORT` (simulated file write only under explicit opt-in, still reported as failure) | same | ❌ | **SIMULATED** |

Each backend declares what it accepts through `SupportsKind`, and the Agent reports
`capabilities.supported_protocols` in heartbeat inventory so routing can refuse an incompatible job **before** it
is queued. A Windows spooler queue has an immutable document baseline (`pdf`, `image`) even when an old
record has no `supported_protocols`; RAW/ESC/POS are additive opt-ins and are never inferred from a queue name,
printer class, USB identity, or the fact that Windows can expose a RAW datatype.

## 3. Capability enforcement (two layers)

**Gateway** (`validatePayloadForPrinter` in `src/lib/routing.ts`):

* for document transports, the physical transport baseline is authoritative: Windows spooler supports driver-rendered `pdf`/`image`, and IPP/IPPS supports `pdf`, even for legacy rows that predate `supported_protocols`;
* `raw`, `escpos`, `zpl`, and `tspl` require explicit byte-language evidence. A spooler queue gets RAW/ESC/POS only from explicit passthrough capability; direct USB/TCP gets only the declared protocol. Missing capability metadata never upgrades a device to a byte protocol;
* an automatic discovery candidate with an unknown byte language remains non-executable. Discovery-only LPR/WSD/SNMP/TCP/USB observations cannot become runnable inventory merely because an old registry row exists.

A mismatch is `CAPABILITY_MISMATCH` → HTTP **422** at job creation, and it is
terminal: neither the Gateway nor the Odoo submit path retries the next
binding (Odoo terminalizes 400/403/404/409/422 as `failed`). Fix the binding's
protocol/transport instead of resubmitting.

**Agent** (`processJob` in `agent/internal/agent/agent.go`): re-checks `SupportsKind`
before anything is written anywhere and fails the job with
`CAPABILITY_MISMATCH: printer <id> cannot print <kind> payloads`, which the gateway stores
in `job.error` with `job.status = failed`.

## 4. Windows PDF printing (embedded PDFium)

`agent/internal/printer/pdf.go` + `agent/internal/printer/pdf_windows.go` use the
embedded PDFium WebAssembly runtime provided by `github.com/klippa-app/go-pdfium`
(v1.19.8) through Wazero. PDF bytes are validated, materialised only in a secure
0600 temporary file for the existing print seam, opened by PDFium, rendered one
page at a time, and submitted through the Windows printer device context.

There is no external PDF application, shell verb, file association, PATH lookup,
runtime renderer download, browser engine, or customer-installed PDF software.
The PDFium WASM module is embedded in the Agent binary by go-pdfium, and the
Wazero filesystem is explicitly isolated from the host filesystem.

The shared Agent payload limit remains 5 MiB. PDF validation requires `%PDF-` at byte zero and a `%%EOF` marker within the final 4 KiB (trailing padding is allowed). PDF-specific protection also
limits documents to 500 pages and caps one rendered page at 16 million pixels
(about 64 MiB for the 32-bit bitmap before renderer overhead). The renderer pool
has one live worker and PDF jobs are serialized so PDF rendering cannot create
unbounded renderer memory or goroutine pressure.

The first page is rendered before `StartDocW`, so deterministic renderer/printer
pre-dispatch failures are returned normally. Once `StartDocW` has succeeded,
rendering, cancellation, page submission, spooler, and finalization failures are
reported using the Agent's existing unknown-physical-outcome semantics rather
than claiming that the document was not printed.

Page dimensions come from the PDF and are fitted to the printer-reported
printable area while preserving aspect ratio; printer physical offsets and DPI
are honoured. A4, Letter, receipt-sized pages, portrait/landscape documents,
rotated pages, images, text, vector content, grayscale, and multi-page jobs are
covered by the renderer path; physical output still requires Windows hardware
verification.

## 5. Backend reference (one section per implemented backend)

Each backend implements `Printer` (`Print`, `Test`, `Status`) and, where it matters,
`SupportsKind` / `PrintDocument` from `agent/internal/printer/document.go`. The factory that
maps configuration to a backend is `agent/internal/printer/factory.go`.

### 5.1 Network RAW TCP — `NetworkPrinter` (`network.go`)

| Aspect | Detail |
|---|---|
| Protocol | Raw byte stream over TCP on canonical port 9100 (JetDirect/AppSocket). No document model, no acknowledgement |
| Document kinds | `raw` ✅ · `escpos` ✅ · `image` ✅ only for `escpos` protocol · `pdf` ❌ → `CAPABILITY_MISMATCH` |
| Configuration | `type: network` (alias `tcp`), `endpoint: <ip>:<port>`, `protocol: raw`, `escpos`, `zpl`, or `tspl` |
| Capability reporting | Without an explicit override the heartbeat derives only the configured language: `raw` → `[raw]`, `escpos` → `[escpos, image]`, `zpl` → `[zpl]`, `tspl` → `[tspl]`. An explicit supported-protocol list remains authoritative for this direct byte transport. |
| Error handling | `DialContext` with a 5 s dial timeout, deadline from the job context (else 15 s), short-write loop, refuses empty and > 5 MiB payloads. Dial/write errors are returned verbatim to the gateway |
| Status probe | 2 s TCP dial → `online` / `offline` (a successful handshake, not paper) |
| Platform limits | None — identical on Windows/Linux/macOS |
| Discovery | Active TCP 9100 scan of private IPv4 subnets (`network_discovery.go`) |
| Physical verification | **NOT VERIFIED** on a real device. Byte-for-byte transmission is **VERIFIED** against a local mock listener (`network_test.go`, `pdf_test.go`, `internal/integration/mock_e2e_test.go`) |

### 5.2 JPEG raster limits and paper width

JPEG dimensions are inspected with `jpeg.DecodeConfig` before full decode. Either source dimension above 16,384 pixels, a source image above 40,000,000 pixels, or a projected ESC/POS raster above 32 MiB is rejected. Raster width defaults conservatively to 384 dots. A single explicit desired-state `config.paper_widths` value is carried separately as millimetres (`paper_width_mm`) and mapped to the supported raster width (for example, 80 mm → 576 dots); ambiguous multi-width configuration does not widen the default.

### 5.3 Windows print spooler — `SpoolerPrinter` (`spooler_windows.go`)

| Aspect | Detail |
|---|---|
| Protocol | Document jobs use the Windows driver/GDI path (`StartDocW`/page rendering). Explicit byte-passthrough jobs use Winspool RAW (`OpenPrinterW` → `StartDocPrinterW` with datatype `RAW` → `StartPagePrinter` → `WritePrinter` loop → `EndPagePrinter` → `EndDocPrinter`) |
| Document kinds | `pdf` ✅ · `image` ✅ by default; `raw`/`escpos` ✅ only when explicitly declared as spooler passthrough |
| Configuration | `type: spooler` plus `spooler_name` (falls back to `endpoint`). A local USB printer installed as a Windows printer is configured this way and does **not** require IP/port metadata |
| Capability reporting | Legacy/missing capability rows derive `[pdf, image]`; explicit passthrough may add `raw` and/or `escpos` without removing document support |
| Error handling | Short writes are completed in a loop. Pre-dispatch failures remain definite. After Windows allocates a spooler job ID, a later document failure is an **unknown physical outcome** and retains that job ID; cleanup after successful `EndDoc` cannot turn the completed submission into a safe-to-retry failure |
| Status probe | `PRINTER_INFO_2.Status` is reduced with the discovery reducer. Explicit queue/device fault bits map to `offline`/`error`/`busy`; `SERVER_UNKNOWN`, timeout, and `OpenPrinterW` access/security-context failure are `unknown`, not physical Offline |
| Platform limits | Windows only. The `!windows` build is a simulation (§5.3) |
| Discovery | `EnumPrintersW` level 2 with correct `PRINTER_INFO_2W` parsing; non-printer PnP entries are filtered out (`isValidSpoolerPrinter`), status/attributes mapped by `classify.go` |
| Physical verification | **COMPILE VERIFIED** only (`GOOS=windows go build/vet`). No paper has been produced in CI |

### 5.4 Spooler stub for non-Windows builds (`spooler_stub.go`)

| Aspect | Detail |
|---|---|
| Purpose | Lets the full agent pipeline link and run in CI and on developer machines without a Windows spooler |
| Behaviour | By default every print fails with `ERR_UNSUPPORTED_TRANSPORT` - nothing pretends to have printed. Only when the operator explicitly sets `ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1`, `raw`/`escpos` are written to `<tmp>/spooler_<name>_<ts>.prn` and `pdf` is validated then written to `<tmp>/spooler_<name>_<ts>.pdf`; even the simulated write is reported back as a `SIMULATED_TRANSPORT` failure, never as success |
| Document kinds | Same matrix as the real spooler, so capability routing behaves identically in CI |
| Status probe | `unknown` without a probe (an unreadable state, never healthy); `"online"` only under the explicit simulation opt-in |
| Physical verification | **SIMULATED** — never counts as evidence of printing |

### 5.5 IPP / IPPS — `IPPPrinter` (`ipp.go`)

| Aspect | Detail |
|---|---|
| Protocol | IPP 2.0 `Print-Job` (0x0002) over HTTP POST `application/ipp`, with `attributes-charset`, `attributes-natural-language`, `printer-uri`, `requesting-user-name`, `document-format`, `job-name` |
| Document kinds | `pdf` ✅ as `application/pdf`; `raw` / `escpos` ❌ → `CAPABILITY_MISMATCH` |
| Configuration | `type: ipp` or `ipps` (also `type: network` with `protocol: ipp`), `endpoint:` an `ipp://`, `ipps://`, `http://` URL or a bare `host:port` — normalised by `normalizeIPPURL`; `ipp://` and `ipps://` default to port 631 when omitted |
| Capability reporting | `supported_protocols: [pdf]` |
| Error handling | Non-2xx HTTP and IPP client/server error classes (`0x04xx`/`0x05xx`) become job errors with decoded status text; the complete `0x00xx` success class is accepted. Responses shorter than the IPP header are rejected. The client timeout is 15 s, shortened to the job deadline when smaller |
| Status probe | `Get-Printer-Attributes` (5 s): idle/processing → `online`/`busy`; explicit `offline`/`shutdown` reasons → `offline`; stopped/paused/admission/media/cover/toner/jam faults → `error`; probe/auth/protocol/transport failure → `unknown`. `printer-state-reasons` is retained as diagnostic detail |
| Platform limits | None |
| Discovery | Bounded mDNS/DNS-SD browse for `_ipp._tcp`, `_ipps._tcp`, and `_printer._tcp`, merged with the TCP 631 scan in `ipp_discovery.go`; partial mDNS failures do not discard successful candidates. |
| Physical verification | **NOT VERIFIED** against a real IPP printer. Request construction and status parsing are **VERIFIED** with `httptest` (`ipp_test.go`) |

### 5.6 Direct USB — `USBPrinter` (`usb_windows.go`)

| Aspect | Detail |
|---|---|
| Protocol | `CreateFile` on the discovered `\\?\usb#…` device interface path + `WriteFile` loop |
| Document kinds | Top-level `raw` ✅ when the configured protocol is `raw`, `zpl`, or `tspl` and the payload declares that matching protocol; top-level `escpos` ✅ only when protocol=`escpos`; `pdf`/`image` ❌ → `CAPABILITY_MISMATCH` (there is no driver renderer; install the device as a Windows printer and route to the spooler queue) |
| Configuration | `type: usb` with a real USBPRINT device path and an **explicit** `raw`, `escpos`, `zpl`, or `tspl` protocol. `usb_vid`/`usb_pid`/`usb_serial` identify the device but do not prove its printer language. When `spooler_name` is present the factory builds a **spooler** backend instead — that is the recommended document-printing setup |
| Capability reporting | Derives only the explicitly declared byte language (`[raw]`, `[escpos]`, `[zpl]`, or `[tspl]`); it never assumes that a USB/thermal printer is ESC/POS, ZPL, or TSPL |
| Error handling | Without a device path or explicit byte protocol the backend fails closed with a diagnostic. `CreateFile`/`WriteFile` errors are wrapped with the device identity |
| Status probe | USBPRINT interface presence/openability does not prove paper/device readiness; both successful open and access/sharing failures remain physical `unknown` unless stronger device evidence exists |
| Identity | `Identify()` prefers serial → USB location → `VID:PID` |
| Platform limits | Windows only. On other platforms the backend fails with `ERR_UNSUPPORTED_TRANSPORT` (`Status()` is `unknown`) unless the operator explicitly sets `ODOO_PRINT_AGENT_ALLOW_SIMULATED_TRANSPORT=1` for development diagnostics; simulated writes are then reported as failures prefixed `SIMULATED_TRANSPORT`, never as success |
| Discovery | Primary enumeration uses the USBPRINT device-interface GUID with `DIGCF_PRESENT|DIGCF_DEVICEINTERFACE`; bounded fallback metadata enumeration may use all present classes. Candidate-only USB observations are not executable until a valid path/protocol is proved |
| Physical verification | **COMPILE VERIFIED** only |

### 5.7 ESC/POS

ESC/POS is **not a backend** — it is a payload dialect (`ESC @` initialise … optional cut) carried
only by a byte-stream transport that is explicitly declared ESC/POS-capable: an ESC/POS TCP endpoint, an explicit spooler passthrough,
or an explicit direct-USB ESC/POS device. A thermal-looking device is never assumed to be ESC/POS. IPP/IPPS is a document transport and accepts PDF as `application/pdf`; the agent never generates or rewrites ESC/POS
for a job; the only ESC/POS the gateway produces itself is the test-print payload
(`buildTestPrintPayload` in `src/lib/payload.ts`).

## 6. Printer identity

Stable ids are derived deterministically (`stable_id.go`), preferring identity that survives queue renames or address changes:

* cross-source hardware identity: printer UUID → serial + manufacturer/model → MAC (IPP identities also include the queue resource path so distinct queues on one device remain distinct)
* Windows spooler identity: server + port + driver + share when available; the normalized queue-name hash is a backwards-compatible fallback for older rows
* direct USB: serial scoped to VID/PID when available; VID/PID/location and legacy fallbacks preserve compatibility where stronger identity is absent
* network/IPP fallbacks: normalized host/port or endpoint; IPP uses its resource path so a host address change does not collapse separate queues

Registry reconciliation preserves an already persisted printer ID when the stronger physical identity proves that a renamed/re-addressed observation is the same device/queue.

Repeated discovery updates the existing record (`registry.go: UpsertRegistry`, `seen` map in
`discovery.go`) — discovery is idempotent. The heartbeat upsert is scoped to the reporting
agent, so one agent can never overwrite another agent's printer row.

## 7. Discovery sources

| Source | Status |
|---|---|
| `discoverFromConfig` — printers listed in `config.yaml` | implemented (legacy, still supported) |
| `discoverSpoolerPrinters` — `EnumPrintersW` level 2, correct `PRINTER_INFO_2W` parsing, non-printer PnP entries filtered out | implemented (Windows); **COMPILE VERIFIED** |
| `loadRegistryPrinters` — durable `printers.json` next to `config.yaml` | implemented, atomic writes; used for startup/backward-compatible local state, **not** as live-presence evidence during authoritative reconciliation |
| `discoverNetworkPrinters` — active TCP 9100 scan of private IPv4 subnets, `/16`+ clamped to `/24`, 32 workers, 500 ms per host, 8 s global budget | implemented |
| `discoverUSBPrinters` — `SetupDiGetClassDevsW`, VID/PID/serial parsing, device-interface path map | implemented (Windows); **COMPILE VERIFIED** |
| `discoverIPPPrinters` — TCP 631 scan (+ best-effort name lookup) | implemented |
| mDNS (`_ipp._tcp`, `_ipps._tcp`, `_printer._tcp`), SNMP (`1.3.6.1.2.1.43`), WSD | implemented; bounded, best-effort discovery with result de-duplication; WSD emits the normative probe plus a legacy compatibility variant |

`DiscoverQuick` replays config + local spooler + durable registry at startup so previously configured printers remain available immediately. Full **live** discovery then excludes registry replay as presence evidence: only an authoritative successful Windows spooler enumeration may remove an automatically discovered spooler row that disappeared. Partial/source-error scans never prune healthy durable rows, and silent USB/network non-response is not treated as deletion. Every source is isolated with `recover()`, and results are de-duplicated by stable identity/transport facts.

## 8. Manual registration

```powershell
# Network RAW 9100 (thermal ESC/POS)
yaseir-agent-cli.exe printers add --name "Kitchen 9100" --type network --endpoint 192.168.1.50:9100 --protocol escpos --printer-type thermal

# Windows spooler queue (local, shared, or a USB printer installed as a Windows printer)
yaseir-agent-cli.exe printers add --name "Office Laser" --type spooler --spooler-name "HP LaserJet M402" --printer-type laser

# USB with VID/PID (still needs a spooler queue for PDF work)
yaseir-agent-cli.exe printers add --name "Zebra Label" --type usb --vid 0A5F --pid 014E --serial 123456 --printer-type label --spooler-name "Zebra GK420d"

# IPP
yaseir-agent-cli.exe printers add --name "Office IPP" --type ipp --endpoint ipp://192.168.1.60/ipp/print --protocol ipp
```

Other CLI verbs: `printers list`, `printers discover`, `printers test <id>`,
`printers remove <id>`, plus `-config <path>` and `--json`.

`printers discover --json` writes the current scan's device array to stdout
(`[]` when empty), with diagnostics on stderr. The desktop reads this result
directly, so failed registry persistence cannot substitute stale inventory.
`printers.json` is canonical; `printers: []` in `config.yaml` is fine.

## 9. Diagnostics

* `POST /api/printers/:id/test-connection` — **no job is created**. Returns the cached
  heartbeat reachability (`latencyMs` is always `null`; the gateway cannot dial the LAN and
  a live agent probe is not implemented).
* `POST /api/printers/:id/test-print` — **a real job** through the normal pipeline
  (`queued → claimed → delivery → printing → success|failed`), using a test ticket
  built in the language the printer declares (ESC/POS, ZPL, TSPL, raw, or a minimal
  PDF for spooler/IPP transports) — see §10 below, not ESC/POS-only.

## 10. Success semantics (honest)

* RAW TCP success = the kernel accepted the bytes on the socket. POS printers rarely
  acknowledge paper.
* Spooler success = `WritePrinter`/`EndDocPrinter` returned success, i.e. the job was
  accepted by the Windows spooler.
* PDF/spooler document success = Windows accepted/finalized the driver-rendered document. If a later error occurs after a spooler job ID was allocated, the outcome remains `unknown` rather than `not_printed`.
* IPP success = the printer answered IPP status `0x0000`.

None of these prove that a physical page came out. Bidirectional paper-level status is not
implemented.

## 11. Limits and known behaviour

* Payload: 1 B … 5 MiB decoded, enforced on both sides (`payload.go`, `payload.ts`).
* One `sync.Mutex` per printer: jobs for the same printer are serialised, different
  printers run concurrently (max 8 executing, 64 accepted — `agent.go`).
* Physical print timeout: a size-scaled budget (2 min base + 30 s per MiB) bounds one physical print; the document layer never clamps it down to a constant, and finer per-write stall detection applies inside the transports. A permanently stuck device still fails, but a legitimate multi-hundred-KB raster on a slow thermal is never cut mid-payload. PDF submission has its own 120 s bound.
* Crash/ambiguous-submission window: a job that may have crossed the physical submission boundary remains an `unknown` physical outcome and preserves spooler evidence when available. Automatic retry is not allowed. A manual reprint is a **new explicit physical attempt** and can create a duplicate page if the first attempt actually printed; inspect the device/spooler before choosing it.
## Production Engineering Semantics

- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (90–3600 seconds). Values outside that range fall back to the default rather than being clamped. The 90s floor is a cross-system invariant, not a tuning convenience: the Agent hardcodes a 90s `staleClaimSafetyWindow` and uses it to prove, after a failed `claimed → printing` report, that no reclaim could have completed. A Gateway threshold below 90 would let the Gateway requeue and reassign a job the Agent still believes it owns, producing a duplicate physical print. Lower the floor only together with the Agent's constant; `tests/stale-threshold.test.ts` parses the Go source and enforces the relationship. Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `raw`, `escpos`, `pdf`, and `image`. ZPL and TSPL remain printer protocols carried by the `raw` wire kind. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS, and `image` currently requires JPEG bytes. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.


### Windows service account visibility

LocalSystem enumerates machine queues and its own connections, not another user's connected printers. For a shared queue missing from discovery, install it for the Agent's service account (or as a machine connection), grant that account print access, then restart discovery. A queue visible only in an interactive user's Settings does not establish service access. Discovery reports include this account diagnostic; the Agent does not impersonate users or fabricate accessible queues.

New physical dispatch requires an acknowledged, claim-fenced `printing` response (`success: true`, `status: "printing"`). Local delivery receipt age is diagnostic only; a buffered frame may already have a stale claim. An unacknowledged admission sends no hardware bytes. Printing that already crossed this boundary retains its durable outcome reporting through a later disconnect. Repeated admission for the same live printing claim is acknowledged without creating another job or physical attempt.

PDF rendering preserves the caller-assigned deadline and cancellation throughout document dispatch. Kind-specific timeouts apply only without a caller deadline. Windows aborts unfinished GDI documents; an abort does not prove that no physical page was emitted, so post-admission failures remain unknown outcomes.
