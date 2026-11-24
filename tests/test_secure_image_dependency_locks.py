"""Release invariants for the reviewed immutable container dependency fixes."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "docs/runtime-hardening"


def test_alpine_security_artifacts_are_exact_for_each_parent_and_architecture():
    manifest = json.loads((PROFILE / "alpine-security-artifacts.json").read_text())
    expected = {
        "postgres": {"musl": "1.2.6-r3", "musl-utils": "1.2.6-r3", "zlib": "1.4-r0"},
        "caddy": {"musl": "1.2.5-r24", "musl-utils": "1.2.5-r24", "zlib": "1.4-r0", "brotli-libs": "1.2.1-r0"},
    }
    dockerfile = (ROOT / "Dockerfile.secure-images").read_text()
    pins = re.findall(r"^ADD --checksum=sha256:([0-9a-f]{64}) (https://\S+) (/os-security/\S+)$", dockerfile, re.M)
    assert sorted(pins) == sorted((entry["sha256"], entry["url"], entry["destination"]) for entry in manifest["artifacts"])
    for profile, packages in expected.items():
        for arch in ("x86_64", "aarch64"):
            entries = [entry for entry in manifest["artifacts"] if entry["profile"] == profile and entry["architecture"] == arch]
            assert {entry["package"]: entry["version"] for entry in entries} == packages
        for package, version in packages.items():
            assert f"'{package}={version}'" in dockerfile
    assert "apk add --no-network --no-cache" in dockerfile
    assert "brotli-libs>=" not in dockerfile


def test_go_rebuilds_use_checksum_locked_fixed_dependency_graphs():
    dockerfile = (ROOT / "Dockerfile.secure-images").read_text()
    for name, deps in {
        "gosu": {"github.com/moby/sys/user": "v0.4.1", "golang.org/x/sys": "v0.44.0"},
        "caddy": {
            "github.com/go-chi/chi/v5": "v5.4.0",
            "github.com/go-jose/go-jose/v4": "v4.1.6",
            "golang.org/x/net": "v0.62.0",
        },
    }.items():
        lock = (PROFILE / name / "go.mod").read_text()
        sums = (PROFILE / name / "go.sum").read_text()
        for module, version in deps.items():
            assert re.search(rf"^\s*{re.escape(module)} {re.escape(version)}(?:\s|$)", lock, re.M)
            assert re.search(rf"^{re.escape(module)} {re.escape(version)} h1:", sums, re.M)
        assert f"COPY docs/runtime-hardening/{name}/go.mod docs/runtime-hardening/{name}/go.sum ./" in dockerfile
    assert dockerfile.count("go build -mod=readonly -trimpath") == 2
    assert "go get " not in dockerfile
