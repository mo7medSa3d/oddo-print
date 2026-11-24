#!/usr/bin/env python3
"""Repackage the hash-locked Pillow wheel as Ubuntu's system python3-pil package."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import zipfile

WHEEL_NAME = (
    "pillow-13.0.0-cp312-cp312-manylinux_2_27_x86_64."
    "manylinux_2_28_x86_64.whl"
)
WHEEL_SHA256 = "42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca"
UPSTREAM_VERSION = "13.0.0"
DEB_VERSION = "13.0.0-1yaseir1"


def _safe_wheel_path(member: str) -> tuple[str, str] | None:
    if not member or "\\" in member or member.startswith("/"):
        raise ValueError(f"Unsafe wheel member path: {member!r}")
    path = PurePosixPath(member)
    if any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"Unsafe wheel member path: {member!r}")
    if member.endswith("/"):
        return None
    if path.parts[0].endswith(".data"):
        if len(path.parts) < 3 or path.parts[1] not in ("purelib", "platlib"):
            raise ValueError(f"Unexpected Pillow wheel installation scheme: {member!r}")
        return "/usr/lib/python3/dist-packages", str(PurePosixPath(*path.parts[2:]))
    return "/usr/lib/python3/dist-packages", str(path)


def _verify_wheel(wheel: Path, expected_sha256: str = WHEEL_SHA256) -> list[tuple[zipfile.ZipInfo, str]]:
    if wheel.name != WHEEL_NAME:
        raise ValueError(f"Unexpected Pillow wheel filename: {wheel.name}")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise ValueError(f"Pillow wheel SHA-256 mismatch: {digest}")
    with zipfile.ZipFile(wheel) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > 4096:
            raise ValueError("Pillow wheel member count is outside reviewed bounds")
        if sum(info.file_size for info in infos) > 128 * 1024 * 1024:
            raise ValueError("Pillow wheel exceeds reviewed uncompressed size")
        metadata = [i for i in infos if i.filename.lower().endswith(".dist-info/metadata")]
        wheel_metadata = [i for i in infos if i.filename.lower().endswith(".dist-info/wheel")]
        if len(metadata) != 1 or len(wheel_metadata) != 1:
            raise ValueError("Pillow wheel must contain one METADATA and one WHEEL file")
        meta_text = archive.read(metadata[0]).decode("utf-8")
        name = re.search(r"^Name:\s*(.+)$", meta_text, re.MULTILINE | re.IGNORECASE)
        version = re.search(r"^Version:\s*(.+)$", meta_text, re.MULTILINE | re.IGNORECASE)
        if not name or name.group(1).strip().lower() != "pillow":
            raise ValueError("Pillow wheel project metadata does not match")
        if not version or version.group(1).strip() != UPSTREAM_VERSION:
            raise ValueError("Pillow wheel version does not match the reviewed runtime lock")
        wheel_text = archive.read(wheel_metadata[0]).decode("utf-8")
        tags = re.findall(r"^Tag:\s*(.+)$", wheel_text, re.MULTILINE)
        if not any(
            tag.startswith("cp312-cp312-manylinux_2_27_x86_64")
            or tag.startswith("cp312-cp312-manylinux_2_28_x86_64")
            for tag in tags
        ):
            raise ValueError("Pillow wheel is not the reviewed CPython 3.12 x86_64 build")
        rows: list[tuple[zipfile.ZipInfo, str]] = []
        seen: set[str] = set()
        has_init = False
        for info in infos:
            install = _safe_wheel_path(info.filename)
            if install is None:
                continue
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ValueError(f"Wheel contains a symbolic link: {info.filename}")
            if info.is_dir():
                continue
            root, relative = install
            destination = str(PurePosixPath(root) / relative)
            if destination in seen:
                raise ValueError(f"Duplicate wheel destination: {destination}")
            seen.add(destination)
            if relative == "PIL/__init__.py":
                has_init = True
            rows.append((info, destination))
        if not has_init:
            raise ValueError("Pillow wheel is missing PIL/__init__.py")
        return rows


def build_package(wheel: Path, package_root: Path, expected_sha256: str = WHEEL_SHA256) -> None:
    rows = _verify_wheel(wheel, expected_sha256)
    if package_root.is_symlink():
        raise ValueError("Refusing to replace a symlink as the package root")
    if package_root.exists():
        shutil.rmtree(package_root)
    (package_root / "DEBIAN").mkdir(parents=True, mode=0o755)
    with zipfile.ZipFile(wheel) as archive:
        for info, destination in rows:
            target = package_root / destination.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            target.write_bytes(archive.read(info))
            source_mode = (info.external_attr >> 16) & 0o777
            target.chmod(0o755 if source_mode & 0o111 or target.suffix == ".so" else 0o644)
    control = (
        "Package: python3-pil\n"
        f"Version: {DEB_VERSION}\n"
        "Architecture: amd64\n"
        "Maintainer: Yaseir Runtime Build <noreply@users.noreply.github.com>\n"
        "Section: python\n"
        "Priority: optional\n"
        "Depends: python3 (>= 3.12), python3 (<< 3.13), libc6 (>= 2.27)\n"
        "Description: Pillow 13.0.0 for the hardened Odoo system Python\n"
        " Replaces Ubuntu's vulnerable python3-pil 10.2 package with the same\n"
        " hash-verified upstream Pillow wheel used by the isolated Odoo venv.\n"
    )
    control_path = package_root / "DEBIAN" / "control"
    control_path.write_text(control, encoding="utf-8")
    control_path.chmod(0o644)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("package_root", type=Path)
    args = parser.parse_args()
    build_package(args.wheel, args.package_root)
    print(f"Prepared python3-pil {DEB_VERSION} from SHA-256-verified Pillow {UPSTREAM_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
