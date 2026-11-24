# Exact Windows release acceptance

This is an executable acceptance procedure for the **final signed Windows x64
candidate**. It is not evidence that these stages already ran. The Linux checks,
Windows source cross-compilation and pure PowerShell helper tests in the source
verification package do not execute SCM, DPAPI, Windows ACLs, USB, GDI, WebView2 or
NSIS. Every unobserved stage below remains **BLOCKED**.

Use dedicated Windows 11 x64 build and clean acceptance VMs and authorized test
printers. Use a disposable staging tenant, synthetic receipts and a separate
network. Keep production jobs and production pairing material off these VMs.
Record OS build/patch level, architecture, drivers, printer firmware, WebView2
version, test time and operator. Do not publish credentials, DPAPI ciphertext,
private keys, full configuration files or customer documents in evidence.

## 1. Bind the source and build environment

Verify the delivered final source ZIP SHA-256 independently against its release
manifest, then extract that ZIP to a new checkout. The original input ZIP hash
is provenance; it is not the hash of the modified final source. Use the pinned
Node, Go and Rust versions in `.nvmrc`, `agent/go.mod` and
`src-tauri/rust-toolchain.toml`. Install the MSVC C++ tools/Windows SDK, a supported
Windows CGO compiler for SQLite, the pinned Tauri CLI from the Windows workflow,
PowerShell 7 and Python 3.11 or newer. Record compiler versions and installer
hashes. A missing native compiler is a blocker; `CGO_ENABLED=0` cannot produce the
accepted SQLite agent.

Before the commands below, complete [Windows acceptance toolchain](WINDOWS_TOOLCHAIN_ACCEPTANCE.md)
from the verified source root in the same PowerShell session. That procedure
provisions the pinned supplementary tools and checks the selected native GCC
version, target and executable hash against the build-toolchain manifest.

Use the authorized production publisher certificate already provisioned by the
release owner. `WINDOWS_CERTIFICATE_THUMBPRINT` selects its public identifier;
keep the private key in the approved certificate store/signing system. Do not
use `-GenerateSelfSignedCert` for this procedure or install a new trust root to
make the result pass. Public Authenticode trust, the exact expected leaf
thumbprint, code-signing EKU and successful revocation/chain validation are
required by the verifier. The ordinary builder can make internal test artifacts;
that is a separate scope.

From an elevated PowerShell 7 session at the extracted repository root:

```powershell
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Actual Windows execution is required' }
$Target = 'x86_64-pc-windows-msvc'
$ReleaseEvidence = [IO.Path]::GetFullPath('..\windows-release-evidence')
New-Item -ItemType Directory -Force $ReleaseEvidence | Out-Null
$SourceArchiveSha256 = $env:YASEIR_FINAL_SOURCE_SHA256
$Publisher = $env:WINDOWS_CERTIFICATE_THUMBPRINT
if ($SourceArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Set verified final source SHA-256' }
if ([string]::IsNullOrWhiteSpace($Publisher)) { throw 'Set expected public publisher thumbprint' }
$env:CGO_ENABLED = '1'
Remove-Item Env:GOOS,Env:GOARCH -ErrorAction SilentlyContinue
if ((go env GOOS) -ne 'windows' -or (go env CGO_ENABLED) -ne '1') { throw 'Windows CGO is required' }
# Keep Tauri outputs at the canonical location used by the build/verifier.
Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
python scripts/check-native-backports.py
if ($LASTEXITCODE -ne 0) { throw 'Native backport integrity failed' }
.\tests\windows-release-builder-helpers.ps1
.\tests\windows-native-exit-guards.ps1
.\tests\windows-release-evidence-helpers.ps1
.\scripts\build-windows-installer.ps1 -Target $Target -Bundles nsis *>&1 |
  Tee-Object (Join-Path $ReleaseEvidence 'build.log')
```

Do not use skip switches. Require the builder to finish successfully and retain
its output. Hash `Cargo.lock`, `package-lock.json`, `agent/go.sum` and the final
source ZIP in the release record. This procedure records exact output hashes;
it does not claim byte-for-byte deterministic Authenticode timestamps or NSIS
builds across separate machines.

## 2. Execute the native gates on Windows

Run the exact source's complete Go suite under CGO, including the Windows-only
storage, service ownership, USB and spooler tests. Retain JSON so skipped tests
cannot disappear behind an exit code. The reparse-point ACL test must actually
execute: if the VM disallows symlink creation, enable that capability in this
disposable test environment and rerun; a skip is BLOCKED acceptance.

```powershell
Push-Location agent
try {
  go mod verify
  if ($LASTEXITCODE -ne 0) { throw 'Module verification failed' }
  go test -mod=readonly -race -vet=all -count=1 -json ./... > (Join-Path $ReleaseEvidence 'go-native-tests.jsonl')
  if ($LASTEXITCODE -ne 0) { throw 'Native Go tests failed' }
  go vet -mod=readonly ./...
  if ($LASTEXITCODE -ne 0) { throw 'Native Go vet failed' }
  staticcheck -checks=U1000 ./...
  if ($LASTEXITCODE -ne 0) { throw 'Unused-code gate failed' }
  govulncheck -format json ./... > (Join-Path $ReleaseEvidence 'govulncheck-native.jsonl')
  if ($LASTEXITCODE -ne 0) { throw 'Native govulncheck JSON collection failed' }
  # JSON mode can report findings with exit zero; text mode enforces its finding gate.
  govulncheck ./... *> (Join-Path $ReleaseEvidence 'govulncheck-native.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Native Go vulnerability gate failed' }
} finally { Pop-Location }
Push-Location src-tauri
try {
  cargo fmt --check
  if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed' }
  cargo check --locked --target $Target
  if ($LASTEXITCODE -ne 0) { throw 'Native Rust check failed' }
  cargo test --locked --target $Target
  if ($LASTEXITCODE -ne 0) { throw 'Native Rust tests failed' }
  cargo clippy --locked --target $Target
  if ($LASTEXITCODE -ne 0) { throw 'Native Rust clippy failed' }
  cargo audit --file Cargo.lock --json > (Join-Path $ReleaseEvidence 'cargo-audit.json')
  if ($LASTEXITCODE -ne 0) { throw 'Rust advisory gate failed' }
} finally { Pop-Location }
```

Inspect all diagnostics and the `Action=skip` records. Record the complete
staticcheck result too; the existing U1000 gate does not assert that broader
style/deprecation diagnostics are absent. Local Cargo backports need the
separate source-integrity and optimized GLib checks described in
`src-tauri/vendor/README.md`; Cargo audit may omit local path crates.

Select the single newly built NSIS installer by exact path. Obtain its packaged
`yaseir-manager.exe` with an already reviewed extraction tool, or copy it from an
isolated installation of that exact candidate on the build VM. Tauri patches and
re-signs this payload, then restores the pre-bundle release executable; those
two files can have different hashes. Set `YASEIR_PACKAGED_MANAGER_PATH` to the
exact extracted/copied payload. The verifier requires it and rejects the
canonical pre-bundle path; it cannot prove extraction provenance by itself.
Record the installer, packaged Manager and two signed Go build outputs. The script rejects unsigned,
untrusted, self-signed, changed or unexpected-publisher files.

```powershell
$Installer = [IO.Path]::GetFullPath('src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\Yaseir Print Manager_1.0.0_x64-setup.exe')
$PackagedManager = $env:YASEIR_PACKAGED_MANAGER_PATH
if ([string]::IsNullOrWhiteSpace($PackagedManager)) { throw 'Set the Manager payload path from this exact candidate installer' }
$Manifest = Join-Path $ReleaseEvidence 'signed-candidate.json'
.\scripts\verify-windows-release.ps1 -Mode Record -Target $Target `
  -ManifestPath $Manifest -InstallerPath $Installer -PackagedManagerPath $PackagedManager `
  -ExpectedPublisherThumbprint $Publisher -SourceArchiveSha256 $SourceArchiveSha256
$ManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Manifest).Hash
```

If the package version differs, use the actual exact filename produced by this
build. Transfer the installer, source acceptance scripts and manifest to the
clean VM, with the expected manifest digest and publisher obtained through the
release record. Verify those digests before running anything. Never reuse a
previous download merely because its filename matches.

## 3. Fresh install and real runtime ownership

Start from a clean VM without Node, Go or Rust. Test both a VM without WebView2
and one with the supported runtime already installed. The bootstrapper must
complete successfully; a browser process alone is not runtime detection.
Record Windows Event Log and the installer trace without including configuration
contents. Use an explicit installation path with spaces.

```powershell
$InstallDir = Join-Path $env:ProgramFiles 'Yaseir Print Manager'
$proc = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallDir") -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "Install failed: $($proc.ExitCode)" }
.\scripts\verify-windows-release.ps1 -Mode Installed -ManifestPath $Manifest `
  -ExpectedManifestSha256 $ManifestSha256 -ExpectedPublisherThumbprint $Publisher `
  -InstallDir $InstallDir -OutputPath (Join-Path $ReleaseEvidence 'fresh-installed.json')
.\scripts\smoke-test-windows.ps1 -InstallDir $InstallDir
sc.exe qc YaseirAgent
if ($LASTEXITCODE -ne 0) { throw 'SCM query failed' }
sc.exe qfailure YaseirAgent
if ($LASTEXITCODE -ne 0) { throw 'SCM recovery query failed' }
```

The identity verifier requires the installed Manager, Agent and CLI to match
the candidate hashes, a quoted SCM path pointing to that exact agent and the
actual WebView2 Runtime registry version. Record service account, startup type,
recovery policy and process owner. Require the intended LocalSystem service,
one agent runtime, a functioning desktop/tray, clean duplicate-launch exit,
and no unexpected service image path. Pair only with the synthetic staging
workspace through the ordinary UI, then confirm heartbeat and printer inventory.

The smoke script exercises UI/single-instance/ACL initialization. Its temporary
agent directory is not a production queue, and stopping its process is not a
successful print, graceful service shutdown or crash-recovery acceptance.

## 4. ACL, DPAPI, upgrade and recovery observations

Record each row in `docs/acceptance/windows-result-template.json`, linking raw
logs and SHA-256 values. Start each independent destructive case from a VM
snapshot containing only synthetic data. Keep the VM snapshot separate from the
application's backup/restore proof.

| Gate | Action and required observation |
| --- | --- |
| ACL and owner | Inspect the actual canonical ProgramData agent/manager roots and protected files using `Get-Acl`. Test from a separate standard-user session: agent credentials/queue cannot be read or replaced; Manager trusted settings cannot be changed; reparse points are rejected. Record SID-based owner/DACL summaries, not file contents. Manager standard-user read access is intentional; write access is forbidden. |
| DPAPI | `TestSaveGetRoundTrip` must execute using the Windows storage implementation. In the installed service, verify synthetic credentials survive stop/start and reboot. The implementation deliberately uses **LOCAL_MACHINE** DPAPI so service and desktop can cooperate: ACLs are the confidentiality boundary on the same host. Do not claim user-scoped encryption. A copied synthetic ciphertext on a different machine must fail to decrypt; no plaintext may appear in saved configuration/logs. |
| Fresh and legacy upgrade | Install the approved previous signed version, pair staging and save printer sharing/identity plus a reconciled queue. Upgrade with this exact installer. Verify current hashes again, the existing canonical/legacy configuration is preserved, only one service/agent remains, identity/sharing survives, and service ownership checks refuse an unrelated same-name service in a separate negative fixture VM. |
| Crash before submission | Admit one synthetic operation, stop/kill at the controlled pre-submission point, restart service and inspect queue/remote receipt. Retry is allowed only where evidence proves no submission. Record the canonical operation ID. |
| Crash during/after submission | Interrupt after bytes may have reached the device but before durable success acknowledgement. On restart the operation must be unknown/reconciliation-required with its durable evidence retained. There must be **no automatic reprint or alternate-printer failover**. Repeat with the gateway temporarily unreachable to exercise the report outbox. |
| Reboot | Reboot the test VM in idle state and again with a controlled ambiguous operation. Record boot timestamps, service startup, singleton ownership, durable queue and post-reboot physical count. Unknown outcomes must remain fenced across reboot. |
| Failed upgrade and rollback | Inject a controlled locked owned binary/service-stop failure in a fresh snapshot; require a non-successful installer result and no deletion of unrelated processes/services. For rollback stop new admission, reconcile submitted/unknown work and preserve all ledgers. Install only the explicitly approved compatible previous signed candidate, rerun its hash/ownership checks, then reconnect staging. A restored DB alone or deletion of unknown rows is not a safe rollback. |
| Uninstall | After draining/reconciling synthetic jobs, run the exact installed uninstaller below. Require absent owned service, removed binaries/uninstall entry and documented purge behavior. The current uninstall hooks invoke `-service purge`: canonical/legacy machine product data and the current caller's product data are intentionally purged; unrelated users, services, paths and similarly named binaries must survive. Test a locked-file/pending-delete case separately and follow the secure cleanup runbook. |

For the reboot cases use the VM console to reboot and resume observation. For a
service crash, use the recorded PID of the exact verified service after confirming
the test operation's phase; never kill processes by a broad name match. Record
the phase, service PID, operation ID and physical observation time. Do not expose
tokens in the transcript. The installer and native tests cannot infer paper
output from spooler success.

```powershell
$Uninstaller = Join-Path $InstallDir 'uninstall.exe'
if (-not (Test-Path -LiteralPath $Uninstaller -PathType Leaf)) { throw 'Exact installed uninstaller is missing' }
$proc = Start-Process -FilePath $Uninstaller -ArgumentList '/S' -Wait -PassThru
if ($proc.ExitCode -ne 0) { throw "Uninstall failed: $($proc.ExitCode)" }
.\scripts\verify-windows-release.ps1 -Mode Uninstalled -ManifestPath $Manifest `
  -ExpectedManifestSha256 $ManifestSha256 -ExpectedPublisherThumbprint $Publisher `
  -InstallDir $InstallDir -OutputPath (Join-Path $ReleaseEvidence 'uninstalled.json')
```

The uninstalled verifier covers service/binary removal. Separately record the
uninstall registry entry, product-data purge, unrelated-user preservation and
pending-delete/reboot outcome; do not substitute its scoped PASS for those rows.

## 5. Physical 58/80 mm and identity matrix

Use each supported printer/driver/firmware combination and every advertised
transport: Windows spooler/GDI, direct USB where supported, TCP ESC/POS, and IPP
or IPPS as applicable. Record the exact selected printer identity and endpoint;
redact personal hostnames before distributing evidence. Retain a screenshot or
scan of each synthetic receipt with its job ID and scale reference.

| Case | Required physical and durable evidence |
| --- | --- |
| 58 mm and 80 mm | Print one receipt at each supported width: margins, cut position, no clipping, readable small text, barcode/QR scan, no duplicated pages, no extra blank page. Confirm requested media geometry against actual output. |
| Arabic and mixed content | Include `فاتورة اختبار`, Arabic item names, Latin SKU, Western/Arabic digits, punctuation, totals and a multiline mixed-direction address. Require correct joining, ordering, glyphs and line wrapping on paper for both widths. Include a raster/PDF path and the configured ESC/POS path where advertised. |
| USB and queue identity | Observe the same physical device through USB and Windows queue discovery; it must remain one intended physical destination, not two independent retry targets. Reconnect/change port, rename queue, and use two same-model devices with distinct serials. Preserve distinct identities and sharing. |
| IPP/IPPS identity | Expose authorized IPP and IPPS advertisements for the same device, then an IPv6/IPv4 alias. Require the established deduplication rules to converge to the same physical identity while retaining the secure transport. A certificate failure must not silently downgrade IPPS to plaintext. |
| Pre-byte failure | Unplug/disconnect before submission. Record a proven non-submission error and the permitted bounded retry behavior, with no receipt printed. |
| Partial delivery/disconnect | Disconnect during a sufficiently long receipt. Record observed partial paper, unknown physical outcome, retained reconciliation evidence and zero automatic replay/failover after reconnect. |
| Paper-out/offline/cover-open | Exercise the model's status paths before and after submission. Require truthful status; an ambiguous accepted job remains fenced. The operator must reconcile actual paper before an explicit new print decision. |
| Crash/reboot plus duplicate delivery | Redeliver the same canonical operation after each crash/reboot/network-outage phase. Count sheets and compare durable receipts: at most the original physical attempt, with no automatic replay of unknown work. |
| Sustained controlled run | Run an authorized synthetic workload of known count/duration, recording queue latency, memory, retries and exact physical count. Specify the model, data size and concurrency; do not generalize one device's performance to every supported device. |

A manual reprint requires an explicit operator reconciliation decision and a new
authorized operation; it must never be the background recovery response to an
unknown outcome. All platform, lifecycle and physical rows need actual evidence
before this Windows candidate can be called production accepted.

Primary specifications used by the acceptance checks:

- Microsoft WebView2 runtime distribution/detection: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- Microsoft DPAPI machine-scope behavior: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- Go unsafe pointer/syscall lifetime rules: https://pkg.go.dev/unsafe
- Native backport advisories and exact upstream repair: `src-tauri/vendor/README.md`
