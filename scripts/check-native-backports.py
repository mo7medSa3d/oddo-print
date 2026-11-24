#!/usr/bin/env python3
"""Verify exact local GTK3 security backports without hiding RustSec findings."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import tomllib


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify(root, crate_cache=None):
    vendor = root / "src-tauri/vendor"
    provenance = json.loads((vendor / "PROVENANCE.json").read_text(encoding="utf-8"))
    if provenance["format"] != 1:
        raise ValueError("Unsupported native provenance format")
    packages = provenance["packages"]
    if {package["name"] for package in packages} != {"glib", "glib-macros", "gtk3-macros"} or len(packages) != 3:
        raise ValueError("The three reviewed GTK3 backports are required")
    results = []
    for package in packages:
        directory = vendor / package["name"]
        paths = list(directory.rglob("*"))
        if any(path.is_symlink() for path in paths):
            raise ValueError(f"Symlink in vendored source: {directory}")
        actual = {path.relative_to(directory).as_posix(): sha256(path.read_bytes()) for path in paths if path.is_file()}
        if actual != package["files"]:
            raise ValueError(f"Unreviewed modification or missing file in {package['name']}")
        manifest = tomllib.loads((directory / "Cargo.toml").read_text(encoding="utf-8"))
        if manifest["package"]["name"] != package["name"] or manifest["package"]["version"] != package["upstream_version"]:
            raise ValueError("Backports must preserve their actual upstream package/version identity")
        modified = sorted(name for name, digest in actual.items() if digest != package["original_files"][name])
        if modified != package["modified_files"]:
            raise ValueError(f"Changed patch scope for {package['name']}")
        if crate_cache is not None:
            stem = f"{package['name']}-{package['upstream_version']}"
            archive = crate_cache / (stem + ".crate")
            if sha256(archive.read_bytes()) != package["crate_sha256"]:
                raise ValueError(f"Original crate checksum mismatch: {stem}")
            with tarfile.open(archive) as handle:
                original = {
                    Path(member.name).relative_to(stem).as_posix(): sha256(handle.extractfile(member).read())
                    for member in handle.getmembers() if member.isfile()
                }
            if original != package["original_files"]:
                raise ValueError(f"Original crate file inventory mismatch: {stem}")
        results.append({"package": package["name"], "version": package["upstream_version"], "files": len(actual), "modified_files": modified})
    for path, digest in provenance["patches"].items():
        if sha256((vendor / path).read_bytes()) != digest:
            raise ValueError(f"Backport patch changed: {path}")
    for project, prefix in [(root / "src-tauri", "vendor/"), (root / "src-tauri/native-regressions", "../vendor/")]:
        manifest = tomllib.loads((project / "Cargo.toml").read_text(encoding="utf-8"))
        locked = tomllib.loads((project / "Cargo.lock").read_text(encoding="utf-8"))["package"]
        for package in packages:
            name = package["name"]
            if manifest["patch"]["crates-io"].get(name) != {"path": prefix + name}:
                raise ValueError(f"Local backport is not selected by {project.name}: {name}")
            selected = [entry for entry in locked if entry["name"] == name]
            if len(selected) != 1 or selected[0]["version"] != package["upstream_version"] or "source" in selected[0]:
                raise ValueError(f"Lockfile does not resolve the reviewed local backport: {name}")
        abandoned = {entry["name"] for entry in locked} & {"proc-macro-error", "proc-macro-error-attr", "proc-macro-error2", "proc-macro-error-attr2"}
        if abandoned:
            raise ValueError(f"Abandoned diagnostic package returned to the graph: {sorted(abandoned)}")
    return {"result": "PASS", "packages": results, "rustsec": "RUSTSEC-2024-0429 is addressed by the recorded upstream source fix; no version spoofing or advisory ignore is used."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--crate-cache", type=Path, help="Optional directory containing original checksum-verified .crate archives")
    arguments = parser.parse_args()
    print(json.dumps(verify(arguments.repo.resolve(), arguments.crate_cache), indent=2))


if __name__ == "__main__":
    main()
