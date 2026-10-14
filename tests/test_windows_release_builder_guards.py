"""Release seam source guards; native helper behavior runs on Windows CI.

These checks do not build, invoke the release script, or access private keys.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
BUILDER = (ROOT / "scripts/build-windows-installer.ps1").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/build-windows.yml").read_text(encoding="utf-8")


def test_target_and_explicit_signer_validation_precede_build_steps():
    early = BUILDER.index('Write-Step "Prerequisite check"')
    assert BUILDER.index("$goArchitecture = Get-GoArchitectureForTarget $Target") < early
    assert BUILDER.index("Assert-CodeSigningCertificate $signingCert $thumbprint") < early
    mappings = dict(re.findall(r'"([\w-]+-pc-windows-msvc)"\s*\{ return "(\w+)" \}', BUILDER))
    assert mappings == {
        "x86_64-pc-windows-msvc": "amd64",
        "i686-pc-windows-msvc": "386",
        "aarch64-pc-windows-msvc": "arm64",
    }
    assert 'default { throw "Unsupported Windows release target' in BUILDER


def test_native_tests_precede_architecture_aligned_cgo_builds_and_environment_is_restored():
    assignment = BUILDER.index('$env:GOOS = "windows"')
    assert BUILDER.index("go test .\\... -race -count=1") < assignment
    assert assignment < BUILDER.index("go build -trimpath")
    assert '$env:GOARCH = $goArchitecture' in BUILDER
    assert '$env:CGO_ENABLED = "1"' in BUILDER
    assert re.search(r"finally\s*\{\s*\$env:GOOS = \$savedGoOS\s*\$env:GOARCH = \$savedGoArch\s*\$env:CGO_ENABLED = \$savedCGOEnabled\s*Pop-Location", BUILDER)
    assert "CGO_ENABLED: '1'" in WORKFLOW
    assert "Windows Agent release build failed" in WORKFLOW
    assert "Windows Agent CLI release build failed" in WORKFLOW


def test_each_local_signing_path_checks_signature_and_identity():
    signing_calls = [line for line in BUILDER.splitlines() if "= Set-AuthenticodeSignature " in line]
    validations = [line for line in BUILDER.splitlines() if "= Assert-AuthenticodeSigningResult " in line]
    assert len(signing_calls) == len(validations) == 2
    assert all("-ErrorAction Stop" in line for line in signing_calls)
    assert '[string]$Signature.Status -notin @("Valid", "NotTrusted")' in BUILDER
    assert "$Signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint" in BUILDER
    assert "Publisher trust is not established" in BUILDER
    # An intentional unsigned build is still allowed when no certificate was requested.
    assert "if ($signingCert) {" in BUILDER


def test_private_signing_identity_never_enters_shared_cache_or_pr_environment():
    assert ".yaseir-signing" not in WORKFLOW
    assert "signing-cert-cache" not in WORKFLOW
    assert "$cachedPfx" not in WORKFLOW
    assert "$cachedPassFile" not in WORKFLOW
    for secret in ("WINDOWS_PFX_BASE64", "WINDOWS_PFX_PASSWORD", "GH_PAT_SECRETS"):
        line = next(line for line in WORKFLOW.splitlines() if line.strip().startswith(f"{secret}:"))
        assert "github.ref == 'refs/heads/main'" in line
        assert "github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in line
        assert f"secrets.{secret} || ''" in line
    assert '$hasPfx -ne $hasPassword' in WORKFLOW
    assert "Remove-Item -Force $tempPfx" in WORKFLOW
    assert "Export-Certificate -Cert $cert" in WORKFLOW  # Public certificate remains usable.


def test_native_ci_exercises_only_pure_production_helpers_before_packaging():
    helper_path = "tests/windows-release-builder-helpers.ps1"
    assert helper_path in WORKFLOW
    assert WORKFLOW.index(f"run: ./{helper_path}") < WORKFLOW.index("name: Build Go Agent resources for Tauri")
    behavioral = (ROOT / helper_path).read_text(encoding="utf-8")
    assert "Parser]::ParseFile($builder" in behavioral
    assert "Invoke-Expression $definitions[0].Extent.Text" in behavioral
    assert "HashMismatch" in behavioral and "NotTrusted" in behavioral and "DIFFERENT" in behavioral
    assert not re.search(r"(?m)^\s*(?:&|\.)\s*\$builder", behavioral)
