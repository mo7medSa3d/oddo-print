#!/usr/bin/env python3
"""Verify the live Odoo/pypdf adapter preserves bounded decompression.

This creates only a 1 KiB decoded fixture and an in-memory blank PDF. It does
not connect to a database, start a service, or submit any print job.
"""
import argparse
import io
from pathlib import Path
import sys
import zlib


def verify(source_root):
    root = Path(source_root).resolve()
    sys.path.insert(0, str(root))
    from odoo.tools import pdf as odoo_pdf
    import pypdf
    from pypdf.errors import LimitReachedError

    if not Path(odoo_pdf.__file__).resolve().is_relative_to(root):
        raise SystemExit("Odoo was imported from a different source tree.")
    if odoo_pdf.filters.__name__ != "pypdf.filters":
        raise SystemExit("The verified profile requires modern pypdf, not PyPDF2.")
    with pypdf.apply_configuration(zlib_maximum_output_length=128):
        ordinary = b"ordinary bounded PDF stream"
        if odoo_pdf.filters.FlateDecode.decode(zlib.compress(ordinary)) != ordinary:
            raise SystemExit("FAIL: ordinary PDF stream did not round-trip.")
        try:
            odoo_pdf.filters.FlateDecode.decode(zlib.compress(b"a" * 1024))
        except LimitReachedError:
            pass
        else:
            raise SystemExit("FAIL: Odoo disabled pypdf's configured decompression limit.")
    writer = odoo_pdf.PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    buffer.seek(0)
    if len(odoo_pdf.PdfReader(buffer).pages) != 1:
        raise SystemExit("FAIL: Odoo PDF writer/reader did not round-trip.")
    print("PASS: native pypdf limit, ordinary stream, and Odoo PDF reader/writer.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("odoo_source", help="Patched Odoo source directory")
    verify(parser.parse_args().odoo_source)
