"""Offline integrity and safe replacement gates; actual artifacts have separate evidence."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "docs/runtime-hardening"
SPEC = importlib.util.spec_from_file_location("os_security_profile", PROFILE / "apply-os-security-profile.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

PODLATORS_FIX_SPEC = importlib.util.spec_from_file_location(
    "podlators_security_backport", ROOT / "scripts" / "apply-perl-podlators-security-fix.py"
)
assert PODLATORS_FIX_SPEC and PODLATORS_FIX_SPEC.loader
PODLATORS_FIX = importlib.util.module_from_spec(PODLATORS_FIX_SPEC)
PODLATORS_FIX_SPEC.loader.exec_module(PODLATORS_FIX)


@pytest.fixture
def installation(tmp_path, monkeypatch):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    root = tmp_path / "rtlcss"
    target = root / "node_modules/source-map-js"
    target.mkdir(parents=True)
    (root / "package.json").write_text(json.dumps({"name": "rtlcss", "version": "4.3.0"}))
    (target / "package.json").write_text(json.dumps({"name": "source-map-js", "version": "1.2.1"}))
    (target / "old-only.js").write_text("original fixture")
    archive = artifacts / "source-map-js-1.2.2.tgz"
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(MODULE, "MANIFEST", manifest)

    def package(extra=None, version="1.2.2"):
        files = {"package/package.json": json.dumps({"name": "source-map-js", "version": version}).encode(),
                 "package/lib/security.js": b"reviewed synthetic module"}
        with tarfile.open(archive, "w:gz") as output:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
            if extra:
                output.addfile(extra, io.BytesIO(b"x" * extra.size))
        manifest.write_text(json.dumps({"artifacts": [{"filename": archive.name,
            "bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}]}))
        return files

    expected = package()
    return artifacts, root, target, archive, package, expected


def test_replaces_exact_dependency_removes_stale_files_and_is_idempotent(installation):
    artifacts, root, target, _, _, expected = installation
    MODULE.install_source_map(artifacts, root)
    assert not (target / "old-only.js").exists()
    assert {str(p.relative_to(target)): p.read_bytes() for p in target.rglob("*") if p.is_file()} == {
        name.removeprefix("package/"): data for name, data in expected.items()}
    assert target.stat().st_mode & 0o777 == 0o755
    assert all(p.stat().st_mode & 0o777 == 0o644 for p in target.rglob("*") if p.is_file())
    MODULE.install_source_map(artifacts, root)


def test_checksum_tampering_fails_before_existing_dependency_changes(installation):
    artifacts, root, target, archive, _, _ = installation
    data = bytearray(archive.read_bytes())
    data[-1] ^= 1
    archive.write_bytes(data)
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        MODULE.install_source_map(artifacts, root)
    assert (target / "old-only.js").read_text() == "original fixture"


def test_symlink_artifact_is_refused(installation):
    artifacts, root, target, archive, _, _ = installation
    outside = archive.with_suffix(".outside")
    archive.rename(outside)
    archive.symlink_to(outside)
    with pytest.raises(ValueError, match="regular security artifact"):
        MODULE.install_source_map(artifacts, root)
    assert (target / "old-only.js").exists()


@pytest.mark.parametrize("component,version", [("rtlcss", "4.4.0"), ("source-map-js", "9.0.0")])
def test_unknown_parent_or_dependency_identity_is_refused(installation, component, version):
    artifacts, root, target, _, _, _ = installation
    file = (root if component == "rtlcss" else target) / "package.json"
    file.write_text(json.dumps({"name": component, "version": version}))
    with pytest.raises(ValueError, match="Unreviewed"):
        MODULE.install_source_map(artifacts, root)
    assert (target / "old-only.js").exists()


def test_existing_patched_version_requires_complete_reviewed_bytes(installation):
    artifacts, root, target, _, _, _ = installation
    MODULE.install_source_map(artifacts, root)
    (target / "lib/security.js").write_text("unexpected replacement")
    with pytest.raises(ValueError, match="differs from reviewed artifact"):
        MODULE.install_source_map(artifacts, root)


@pytest.mark.parametrize("kind", ["traversal", "symlink", "duplicate"])
def test_archive_unsafe_members_are_refused_without_extraction(installation, kind):
    artifacts, root, target, _, package, _ = installation
    member = tarfile.TarInfo({"traversal": "package/../../escaped", "symlink": "package/link", "duplicate": "package/package.json"}[kind])
    if kind == "symlink":
        member.type = tarfile.SYMTYPE
        member.linkname = "../../escaped"
    else:
        member.size = 1
    package(member)
    with pytest.raises(ValueError, match="Unexpected npm archive"):
        MODULE.install_source_map(artifacts, root)
    assert (target / "old-only.js").exists()
    assert not (root.parent / "escaped").exists()


def test_archive_package_version_must_match_reviewed_fix(installation):
    artifacts, root, target, _, package, _ = installation
    package(version="1.2.3")
    with pytest.raises(ValueError, match="Unreviewed source-map-js package identity"):
        MODULE.install_source_map(artifacts, root)
    assert (target / "old-only.js").exists()


def test_docker_download_pins_match_reviewed_artifact_manifest():
    manifest = json.loads((PROFILE / "os-security-artifacts.json").read_text())
    dockerfile = (ROOT / "Dockerfile.odoo-hardened").read_text()
    pins = re.findall(r"^ADD --checksum=sha256:([0-9a-f]{64}) (https://\S+) /os-security/(\S+)$", dockerfile, re.M)
    expected_pins = sorted(
        (item["sha256"], item.get("download_url", item["url"]), item["filename"])
        for item in manifest["artifacts"]
    )
    assert sorted(pins) == expected_pins
    snapshot = manifest["ubuntu_provenance"]["snapshot"]
    mirror = "https://is.archive.ubuntu.com/ubuntu/pool/"
    snapshot_packages = [
        item for item in manifest["artifacts"]
        if item["url"].startswith(snapshot + "pool/")
    ]
    assert len(snapshot_packages) == 21
    assert all(item.get("download_url", "").startswith(mirror) for item in snapshot_packages)
    assert all(item["download_url"].endswith("/" + item["filename"]) for item in snapshot_packages)
    assert "dpkg -i /os-security/libssl3t64_3.0.13-0ubuntu3.16_amd64.deb" in dockerfile
    assert "verify-source-map-js-security.cjs" in dockerfile
    assert not re.search(r"(?:apt(?:-get)?\s+(?:update|install)|npm\s+install)", dockerfile)


def test_all_available_parent_security_fixes_have_exact_guarded_artifacts():
    # The 2026-10-24 parent scan and signed noble-security index identify these
    # installed packages with published fixes. Do not silently drop a group
    # when regenerating the immutable artifact profile.
    expected = {
        "curl", "libcares2", "libcurl4t64", "libbrotli1", "libexpat1", "libfreetype6",
        "libglib2.0-0t64", "libpcre2-8-0", "libperl5.38t64", "libpng16-16t64", "libsqlite3-0",
        "libssl-dev", "libssl3t64", "libx11-6", "libx11-data", "libxml2",
        "openssl", "perl", "perl-base", "perl-modules-5.38", "python3-lxml",
        "python3-requests", "python3-urllib3", "zlib1g",
    }
    manifest = json.loads((PROFILE / "os-security-artifacts.json").read_text())
    packages = [entry for entry in manifest["artifacts"] if entry["filename"].endswith(".deb")]
    assert {entry["package"] for entry in packages} == expected
    dockerfile = (ROOT / "Dockerfile.odoo-hardened").read_text()
    for entry in packages:
        assert f'{entry["package"]}|{entry["previous_version"]}|{entry["version"]}' in dockerfile
        assert f'{entry["package"]}={entry["version"]}' in dockerfile
        assert f'/os-security/{entry["filename"]}' in dockerfile


def test_brotli_cve_fix_uses_reviewed_ubuntu_security_artifact_not_scanner_exemption():
    manifest = json.loads((PROFILE / "os-security-artifacts.json").read_text())
    brotli = next(item for item in manifest["artifacts"] if item.get("package") == "libbrotli1")
    assert brotli["version"] == "1.1.0-2ubuntu0.1"
    assert brotli["previous_version"] == "1.1.0-2build2"
    assert brotli["advisories"] == ["CVE-2026-111497"]
    assert brotli["bytes"] == 330968
    assert brotli["sha256"] == "70b188a86d81f30d7510aab30e25d638ed5037dded6691af1533952b71ac61de"
    assert brotli["url"].startswith("https://security.ubuntu.com/ubuntu/")
    docker = (ROOT / "Dockerfile.odoo-hardened").read_text()
    assert f'ADD --checksum=sha256:{brotli["sha256"]} {brotli["url"]} /os-security/{brotli["filename"]}' in docker
    assert f'libbrotli1|{brotli["previous_version"]}|{brotli["version"]}' in docker
    assert f'libbrotli1={brotli["version"]}' in docker
    assert f'/os-security/{brotli["filename"]}' in docker


def test_pcre2_cve_fix_uses_reviewed_ubuntu_security_artifact_not_scanner_exemption():
    # USN-8974-1 (2026-11-03) published the first noble fix for the seven
    # reviewed libpcre2-8-0 findings after the retained snapshot was pinned;
    # the fix must ship as a guarded artifact and leave the Trivy baseline.
    manifest = json.loads((PROFILE / "os-security-artifacts.json").read_text())
    pcre2 = next(item for item in manifest["artifacts"] if item.get("package") == "libpcre2-8-0")
    assert pcre2["version"] == "10.42-4ubuntu2.2"
    assert pcre2["previous_version"] == "10.42-4ubuntu2.1"
    assert pcre2["advisories"] == ["CVE-2026-103111", "CVE-2026-86145", "CVE-2026-89156",
                                   "CVE-2026-89157", "CVE-2026-89158", "CVE-2026-89160",
                                   "CVE-2026-89161"]
    assert pcre2["bytes"] == 228546
    assert pcre2["sha256"] == "f41da7cb7e979d6b037ea92650c72ec8ec532ec3c93aa8d5b997207de56695ea"
    assert pcre2["url"].startswith("https://security.ubuntu.com/ubuntu/")
    assert pcre2["security_notice"] == "https://ubuntu.com/security/notices/USN-8974-1"
    docker = (ROOT / "Dockerfile.odoo-hardened").read_text()
    assert f'ADD --checksum=sha256:{pcre2["sha256"]} {pcre2["url"]} /os-security/{pcre2["filename"]}' in docker
    assert f'libpcre2-8-0|{pcre2["previous_version"]}|{pcre2["version"]}' in docker
    assert f'libpcre2-8-0={pcre2["version"]}' in docker
    assert f'/os-security/{pcre2["filename"]}' in docker
    baseline = json.loads((ROOT / "security" / "image-vulnerability-baseline.json").read_text())
    findings = baseline["images"]["yaseir-odoo-hardened:review-20261105"]["findings"]
    assert not [row for row in findings if row[1] == "libpcre2-8-0"]



def test_podlators_backport_patches_all_four_system_modules_and_is_idempotent(tmp_path):
    root = tmp_path / "Pod"
    for relative, (before, _) in PODLATORS_FIX.PATCHES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(before + "\\n# preserved module content\\n", encoding="utf-8")

    PODLATORS_FIX.apply(root)
    PODLATORS_FIX.apply(root)

    for relative, (_, after) in PODLATORS_FIX.PATCHES.items():
        assert (root / relative).read_text(encoding="utf-8").count(after) == 1


def test_podlators_backport_rejects_unknown_source_before_mutating_any_file(tmp_path):
    root = tmp_path / "Pod"
    originals = {}
    for relative, (before, _) in PODLATORS_FIX.PATCHES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(before + "\\n# original module content\\n", encoding="utf-8")
        originals[relative] = path.read_text(encoding="utf-8")

    (root / "Text/Color.pm").write_text("unexpected upstream source", encoding="utf-8")
    originals["Text/Color.pm"] = "unexpected upstream source"

    with pytest.raises(ValueError, match="Unexpected or ambiguous Pod::Text source"):
        PODLATORS_FIX.apply(root)

    for relative, original in originals.items():
        assert (root / relative).read_text(encoding="utf-8") == original


def test_podlators_cve_backport_is_applied_and_smoke_tested_in_hardened_image():
    dockerfile = (ROOT / "Dockerfile.odoo-hardened").read_text()
    assert "COPY scripts/apply-perl-podlators-security-fix.py" in dockerfile
    assert "python3 /usr/local/bin/yaseir-apply-perl-podlators-security-fix.py" in dockerfile
    assert "timeout 5s perl -MPod::Text" in dockerfile
    for path in (
        "/usr/share/perl/5.38.2/Pod/Text.pm",
        "/usr/share/perl/5.38.2/Pod/Text/Color.pm",
        "/usr/share/perl/5.38.2/Pod/Text/Overstrike.pm",
        "/usr/share/perl/5.38.2/Pod/Text/Termcap.pm",
    ):
        assert path in dockerfile


def test_podlators_backport_rows_are_exact_and_time_bounded():
    baseline = json.loads((ROOT / "security" / "image-vulnerability-baseline.json").read_text())
    entry = baseline["images"]["yaseir-odoo-hardened:review-20261105"]
    expected = {
        ("CVE-2026-82560", "libperl5.38t64", "MEDIUM"),
        ("CVE-2026-82560", "perl", "MEDIUM"),
        ("CVE-2026-82560", "perl-base", "MEDIUM"),
        ("CVE-2026-82560", "perl-modules-5.38", "MEDIUM"),
    }
    assert expected.issubset({tuple(row) for row in entry["findings"]})
    assert entry["expires"] == "2026-12-20"
    review = baseline["reviewNotes"]["yaseir-odoo-hardened:review-20261105"]
    assert "70510174f69eb54aa6d617bde4e1402cd9b7c61f" in review
