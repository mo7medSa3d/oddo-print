"""Keep checked-in TypeScript/JavaScript imports aligned with CI's relative-only rule."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALIAS_PREFIX = "@" + "/"
IMPORT_FROM_ALIAS = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['\"]"
    + re.escape(ALIAS_PREFIX)
)
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs"}


def test_application_and_script_imports_are_relative_only():
    violations = []
    for area in ("src", "scripts"):
        for path in (ROOT / area).rglob("*"):
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                content = path.read_text(encoding="utf-8", errors="replace")
                if IMPORT_FROM_ALIAS.search(content):
                    violations.append(path.relative_to(ROOT).as_posix())
    assert violations == [], f"CI forbids {ALIAS_PREFIX} path aliases: " + ", ".join(sorted(violations))
