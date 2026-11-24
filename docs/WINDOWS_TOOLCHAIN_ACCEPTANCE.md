# Windows acceptance toolchain

Use this procedure before the build and validation commands in
[`WINDOWS_RELEASE_ACCEPTANCE.md`](WINDOWS_RELEASE_ACCEPTANCE.md). It provisions
the tools used by those commands and records their identities. It does not
execute Windows service, installer, DPAPI, driver or physical-printer acceptance.

## Prerequisites

Use a dedicated native Windows x64 build VM, PowerShell 7, Node 24.22.1,
Go 1.26.11, Python 3.11 or newer, rustup/Cargo, MSVC C++ tools and the Windows SDK.
The Go Agent uses SQLite through CGO and also needs an x64 MinGW-w64 GCC
distribution. MSVC supplies the Rust target's compiler; it does not establish
that the Go CGO compiler is present.

Select and retain the exact build-image and GCC-distribution provenance before
building. Put the selected compiler's expected version and executable SHA-256
from that toolchain manifest in `YASEIR_EXPECTED_CGO_VERSION` and
`YASEIR_EXPECTED_CGO_SHA256`. The procedure compares both values with the selected
compiler and requires target `x86_64-w64-mingw32`. It does not invent a tested GCC
version or treat the mutable `windows-latest` runner label as an immutable image.
Keep global `CC` and `CXX` overrides unset so Rust's MSVC selection remains
independent of Go's default GCC selection.

## Provision and record

From the verified source root in the same PowerShell session used for acceptance:

```powershell
# Set YASEIR_EXPECTED_CGO_VERSION and YASEIR_EXPECTED_CGO_SHA256 from the
# selected build-toolchain manifest before invoking this procedure.
& .\scripts\acceptance\provision-windows-acceptance.ps1
if (-not $?) { throw 'Windows acceptance toolchain provisioning failed' }
```

The script installs Rust 1.98.1 for the Windows MSVC target with `rustfmt` and
`clippy`, staticcheck v0.7.0, govulncheck v1.9.0, cargo-audit 0.22.2 and Tauri CLI
2.11.4. Extra executables are installed into `../windows-release-tools`; their
resolved paths and versions are checked. Its environment changes apply to the
current PowerShell process, so continue acceptance in that session.

Retain `../windows-release-evidence/toolchain-public.json`, the selected GCC
distribution manifest, build-image identity and final signed-artifact hashes.
The public record contains tool identities and paths; do not add credentials,
signing material, authenticated browser state or receipt content.

Continue with the native tests, exact resource/bundle builds and installed-host
procedures in [`WINDOWS_RELEASE_ACCEPTANCE.md`](WINDOWS_RELEASE_ACCEPTANCE.md).
Preserve the JSON output of govulncheck and also use its text-mode invocation as
an exit-enforcing gate: JSON mode can exit zero while reporting vulnerabilities.
Review module, imported-package and reachable-symbol scopes separately. A parsed
PowerShell script or successful provisioning is not a passed native acceptance
gate. Missing exact toolchain, signing or Windows/physical execution evidence
leaves the corresponding gate blocked.
