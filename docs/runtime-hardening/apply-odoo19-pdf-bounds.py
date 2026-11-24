#!/usr/bin/env python3
"""Apply one reviewed fix to the exact tested upstream Odoo 19 PDF adapter.

No dependencies, downloads, database changes, or service restarts. Unknown
source revisions fail closed; repeated application is an idempotent no-op.
"""
import argparse
import hashlib
import os
from pathlib import Path
import stat
import tempfile


UPSTREAM_COMMIT = "14f9b8149d5260d92fb74404df09483fb42dd820"
ORIGINAL_SHA256 = "d62adaee9cd31ff535c9fe9b9a5097a7809dd082c1e2b7ffc7da23cded0c4f6a"
PATCHED_SHA256 = "da8fb075e7949f8d9b02b0cc1f365f11e296a7749a318bd0fa9a790b23764672"
NEEDLE = b"pypdf.filters.decompress = lambda data: decompressobj().decompress(data)"
REPLACEMENT = (
    b"# Keep modern pypdf's configured decompression bounds. The historical\n"
    b"# workaround is needed only by the legacy PyPDF2 compatibility adapters.\n"
    b"if pypdf.filters.__name__.startswith(\"PyPDF2.\"):\n"
    b"    pypdf.filters.decompress = lambda data: decompressobj().decompress(data)"
)


def apply(source_root):
    target = Path(source_root) / "odoo/tools/pdf/__init__.py"
    if target.is_symlink() or not target.is_file():
        raise SystemExit("Expected a regular Odoo PDF adapter source file.")
    original = target.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest == PATCHED_SHA256:
        print("Odoo PDF decompression patch is already applied: " + digest)
        return
    if digest != ORIGINAL_SHA256 or original.count(NEEDLE) != 1:
        raise SystemExit("Refusing unrecognized Odoo source. Review against upstream commit " + UPSTREAM_COMMIT)
    patched = original.replace(NEEDLE, REPLACEMENT)
    if hashlib.sha256(patched).hexdigest() != PATCHED_SHA256:
        raise SystemExit("Patched source did not match the reviewed SHA-256.")
    mode = stat.S_IMODE(target.stat().st_mode)
    descriptor, temporary = tempfile.mkstemp(prefix=".pdf-bounds-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(patched)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Applied Odoo PDF decompression patch: " + PATCHED_SHA256)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("odoo_source", help="Separate checkout of the pinned Odoo Community source")
    apply(parser.parse_args().odoo_source)
