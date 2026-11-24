"""Regression tests for the pinned Pillow-to-Debian system package bridge."""

import hashlib
import importlib.util
from pathlib import Path
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "package-pillow-wheel-as-deb.py"
SPEC = importlib.util.spec_from_file_location("package_pillow_wheel_as_deb", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def make_wheel(path: Path, extra=None, version="13.0.0") -> str:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("PIL/__init__.py", "__version__ = '13.0.0'\n")
        archive.writestr("PIL/_imaging.cpython-312-x86_64-linux-gnu.so", b"ELF fixture")
        archive.writestr("pillow-13.0.0.dist-info/METADATA", f"Name: pillow\nVersion: {version}\n")
        archive.writestr(
            "pillow-13.0.0.dist-info/WHEEL",
            "Wheel-Version: 1.0\nTag: cp312-cp312-manylinux_2_28_x86_64\n",
        )
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_builds_deb_tree_from_hash_verified_cp312_wheel(tmp_path):
    wheel = tmp_path / MODULE.WHEEL_NAME
    digest = make_wheel(wheel, {"PIL/Image.py": "ok"})
    package_root = tmp_path / "package"
    MODULE.build_package(wheel, package_root, expected_sha256=digest)
    assert (package_root / "usr/lib/python3/dist-packages/PIL/__init__.py").is_file()
    assert (package_root / "usr/lib/python3/dist-packages/PIL/Image.py").read_text() == "ok"
    assert (package_root / "usr/lib/python3/dist-packages/pillow-13.0.0.dist-info/METADATA").is_file()
    binary = package_root / "usr/lib/python3/dist-packages/PIL/_imaging.cpython-312-x86_64-linux-gnu.so"
    assert binary.stat().st_mode & 0o111
    control = (package_root / "DEBIAN/control").read_text()
    assert "Package: python3-pil\n" in control
    assert f"Version: {MODULE.DEB_VERSION}\n" in control
    assert "Architecture: amd64\n" in control
    assert "python3 (>= 3.12)" in control


def test_rejects_unexpected_wheel_hash(tmp_path):
    import pytest
    wheel = tmp_path / MODULE.WHEEL_NAME
    make_wheel(wheel)
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        MODULE.build_package(wheel, tmp_path / "package", expected_sha256="0" * 64)


def test_rejects_wrong_pillow_version(tmp_path):
    import pytest
    wheel = tmp_path / MODULE.WHEEL_NAME
    digest = make_wheel(wheel, version="12.0.0")
    with pytest.raises(ValueError, match="version does not match"):
        MODULE.build_package(wheel, tmp_path / "package", expected_sha256=digest)


def test_rejects_zip_path_traversal(tmp_path):
    import pytest
    wheel = tmp_path / MODULE.WHEEL_NAME
    digest = make_wheel(wheel, {"../escape": "bad"})
    with pytest.raises(ValueError, match="Unsafe wheel member path"):
        MODULE.build_package(wheel, tmp_path / "package", expected_sha256=digest)


def test_rejects_non_cp312_or_non_x86_64_wheel(tmp_path):
    import pytest
    wheel = tmp_path / MODULE.WHEEL_NAME
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("PIL/__init__.py", "__version__ = '13.0.0'\n")
        archive.writestr("pillow-13.0.0.dist-info/METADATA", "Name: pillow\nVersion: 13.0.0\n")
        archive.writestr(
            "pillow-13.0.0.dist-info/WHEEL",
            "Wheel-Version: 1.0\nTag: cp311-cp311-manylinux_2_28_x86_64\n",
        )
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="CPython 3.12 x86_64"):
        MODULE.build_package(wheel, tmp_path / "package", expected_sha256=digest)


def test_refuses_package_root_symlink(tmp_path):
    import pytest
    wheel = tmp_path / MODULE.WHEEL_NAME
    digest = make_wheel(wheel)
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        MODULE.build_package(wheel, link, expected_sha256=digest)
