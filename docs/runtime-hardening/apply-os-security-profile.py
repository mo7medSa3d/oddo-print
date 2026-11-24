#!/usr/bin/env python3
"""Verify immutable OS artifacts and replace only rtlcss's reviewed dependency.

No downloads, package-manager execution, database access or service operations.
The Dockerfile installs the separately hash-verified Ubuntu packages with dpkg.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

MANIFEST = Path(__file__).with_name("os-security-artifacts.json")


def verify_artifacts(directory):
    root = Path(directory)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for entry in manifest["artifacts"]:
        name = entry["filename"]
        if Path(name).name != name:
            raise ValueError("Artifact manifest requires plain filenames")
        artifact = root / name
        if artifact.is_symlink() or not artifact.is_file():
            raise ValueError("Expected a regular security artifact")
        if artifact.stat().st_size != entry["bytes"]:
            raise ValueError("Security artifact size mismatch")
        with artifact.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != entry["sha256"]:
            raise ValueError("Security artifact SHA-256 mismatch")
    return manifest


def source_map_files(archive):
    files = {}
    total = 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = PurePosixPath(member.name)
            if (not member.isfile() or not name.parts or name.parts[0] != "package"
                    or len(name.parts) < 2 or ".." in name.parts or name.is_absolute()):
                raise ValueError("Unexpected npm archive member")
            relative = str(name.relative_to("package"))
            total += member.size
            if relative in files or len(files) >= 128 or member.size < 0 or total > 2 * 1024 * 1024:
                raise ValueError("Unexpected npm archive bounds")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("Missing npm archive member")
            files[relative] = stream.read()
    package = json.loads(files["package.json"])
    if package.get("name") != "source-map-js" or package.get("version") != "1.2.2":
        raise ValueError("Unreviewed source-map-js package identity")
    return files


def install_source_map(directory, rtlcss_root):
    verify_artifacts(directory)
    root = Path(rtlcss_root)
    target = root / "node_modules" / "source-map-js"
    for path in (root, target.parent, target):
        if path.is_symlink() or not path.is_dir():
            raise ValueError("Expected regular rtlcss directories")
    parent = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if parent.get("name") != "rtlcss" or parent.get("version") != "4.3.0":
        raise ValueError("Unreviewed rtlcss parent; review the image update")
    package = json.loads((target / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != "source-map-js" or package.get("version") not in ("1.2.1", "1.2.2"):
        raise ValueError("Unreviewed original source-map-js package")
    files = source_map_files(Path(directory) / "source-map-js-1.2.2.tgz")
    if package["version"] == "1.2.2":
        current = {str(p.relative_to(target)): p.read_bytes() for p in target.rglob("*") if p.is_file()}
        if current != files or any(p.is_symlink() for p in target.rglob("*")):
            raise ValueError("Existing source-map-js1.2.2 differs from reviewed artifact")
        return
    # This runs during image assembly, before the service exists. Extraction
    # completes in a private sibling directory before replacing the old module.
    with tempfile.TemporaryDirectory(prefix=".source-map-security-", dir=target.parent) as temporary:
        stage = Path(temporary) / "package"
        stage.mkdir(mode=0o755)
        for name, data in files.items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            destination.write_bytes(data)
            destination.chmod(0o644)
        shutil.rmtree(target)
        os.replace(stage, target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify", "install-source-map"))
    parser.add_argument("artifact_directory")
    parser.add_argument("--rtlcss-root", default="/usr/local/lib/node_modules/rtlcss")
    args = parser.parse_args()
    if args.action == "verify":
        manifest = verify_artifacts(args.artifact_directory)
        print(f"Verified all {len(manifest['artifacts'])} immutable Odoo OS/JavaScript security artifacts")
    else:
        install_source_map(args.artifact_directory, args.rtlcss_root)
        print("Verified rtlcss4.3.0 uses the complete reviewed source-map-js1.2.2 artifact")
