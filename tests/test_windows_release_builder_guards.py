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
    assert len(signing_calls) == 1 and len(validations) == 2
    assert 'Get-AuthenticodeSignature -LiteralPath $nsis[0].FullName' in BUILDER
    assert 'Set-AuthenticodeSignature -FilePath $nsis[0].FullName' not in BUILDER
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
    for secret in ("WINDOWS_PFX_BASE64", "WINDOWS_PFX_PASSWORD"):
        line = next(line for line in WORKFLOW.splitlines() if line.strip().startswith(f"{secret}:"))
        assert "github.ref == 'refs/heads/main'" in line
        assert "github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in line
        assert f"secrets.{secret} || ''" in line
    assert '$hasPfx -ne $hasPassword' in WORKFLOW
    assert "Remove-Item -Force $tempPfx" in WORKFLOW
    assert "Export-Certificate -Cert $cert" in WORKFLOW  # Public certificate remains usable.
    assert "GH_PAT_SECRETS" not in WORKFLOW
    assert "gh secret set " not in WORKFLOW
    assert "YASEIR_TRUSTED_RELEASE_SIGNING" in WORKFLOW
    assert "Yaseir-Manager-Windows-NSIS-UNTRUSTED-TEST-ONLY" in WORKFLOW
    assert WORKFLOW.index("$chain.Build($cert)") < WORKFLOW.index("Import-Certificate -FilePath $publicCer -CertStoreLocation Cert:")



def test_native_ci_exercises_only_pure_production_helpers_before_packaging():
    helper_path = "tests/windows-release-builder-helpers.ps1"
    step_name = "- name: Verify Windows release helper behavior without building or signing"
    step_start = WORKFLOW.index(step_name)
    helper_step = WORKFLOW[step_start:].split("\n      - name:", 1)[0]
    assert re.search(r"(?m)^\s+shell: pwsh$", helper_step)
    checks = [
        helper_path,
        "tests/windows-native-exit-guards.ps1",
        "tests/windows-release-evidence-helpers.ps1",
    ]
    positions = []
    for path in checks:
        invocation = re.search(rf"(?m)^\s+\./{re.escape(path)}$", helper_step)
        assert invocation, f"Missing pure helper invocation: {path}"
        positions.append(invocation.start())
    assert positions == sorted(positions)
    assert step_start + positions[-1] < WORKFLOW.index("name: Build Go Agent resources for Tauri")
    behavioral = (ROOT / helper_path).read_text(encoding="utf-8")
    assert "Parser]::ParseFile($builder" in behavioral
    assert "Invoke-Expression $definitions[0].Extent.Text" in behavioral
    assert "HashMismatch" in behavioral and "NotTrusted" in behavioral and "DIFFERENT" in behavioral
    assert not re.search(r"(?m)^\s*(?:&|\.)\s*\$builder", behavioral)


def test_nsis_installed_manager_uses_cryptographic_signature_check_after_tauri_patching():
    # Tauri patches and signs the NSIS executable, then restores the original
    # release EXE. Comparing those two different artifacts by SHA is invalid.
    step = WORKFLOW.split("- name: Install, smoke-test, and fully uninstall NSIS package", 1)[1].split("\n      - name:", 1)[0]
    assert "Get-AuthenticodeSignature -LiteralPath $managerPath" in step
    assert '$managerSignature.Status -ne "Valid"' in step
    assert '$managerSignature.SignerCertificate.Thumbprint -ne $env:YASEIR_SIGNING_THUMBPRINT' in step
    assert 'Cannot verify NSIS-installed Manager without its expected signing thumbprint' in step
    assert "'agent\\YaseirAgent.exe' = 'resources\\YaseirAgent.exe'" in step
    assert "'agent\\yaseir-agent-cli.exe' = 'resources\\yaseir-agent-cli.exe'" in step
    assert 'if ($installedHash -ne $expectedHash)' in step
    assert "'src-tauri\\target\\x86_64-pc-windows-msvc\\release\\yaseir-manager.exe' =" not in step


def test_patched_manager_binary_receives_explicit_cli_signing_config_before_nsis():
    # The failure on main was NotSigned for the installed Manager even though
    # the NSIS setup executable itself was signed. Rust's TAURI_CONFIG alone
    # does not prove that the bundler's Windows settings were overridden.
    build = WORKFLOW.split("- name: Build Tauri Windows NSIS installer", 1)[1].split("\n      - name:", 1)[0]
    sign = WORKFLOW.split("- name: Prepare code-signing certificate and sign Go Agent binaries", 1)[1].split("\n      - name:", 1)[0]
    assert '"TAURI_CONFIG=$tauriConfig"' in sign
    assert '"YASEIR_SIGNING_THUMBPRINT=$($cert.Thumbprint)"' in sign
    assert '$env:YASEIR_SIGNING_THUMBPRINT' in build
    assert '$env:TAURI_CONFIG' in build
    assert 'certificateThumbprint' in build
    assert 'tauri.windows.signing.json' in build
    assert 'cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis --config $signingConfig' in build
    assert '--no-binary-patching' not in build
    verify = WORKFLOW.split("- name: Verify NSIS installer artifact", 1)[1].split("\n      - name:", 1)[0]
    assert "Get-AuthenticodeSignature -LiteralPath $exe[0].FullName" in verify
    assert "Set-AuthenticodeSignature -FilePath $exe[0].FullName" not in verify
    installed = WORKFLOW.split("- name: Install, smoke-test, and fully uninstall NSIS package", 1)[1].split("\n      - name:", 1)[0]
    assert 'Get-AuthenticodeSignature -LiteralPath $managerPath' in installed
    assert '$managerSignature.Status -ne "Valid"' in installed
    assert '$managerSignature.SignerCertificate.Thumbprint -ne $env:YASEIR_SIGNING_THUMBPRINT' in installed


def test_local_windows_builder_passes_signing_overlay_to_cli_when_requested():
    assert 'certificateThumbprint = $signingCert.Thumbprint' in BUILDER
    assert '$buildArgs += @("--config", $tauriSigningConfig)' in BUILDER
    assert '$env:TAURI_CONFIG' in BUILDER
    assert 'if ($signingCert)' in BUILDER
    assert 'Remove-Item -LiteralPath $tauriSigningConfig' in BUILDER
    assert 'Get-AuthenticodeSignature -LiteralPath $nsis[0].FullName' in BUILDER
    assert 'cargo tauri build --target $Target --bundles $Bundles' not in BUILDER
