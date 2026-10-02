#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify that the Odoo addon's translation catalog matches its source.

The Gateway console has ``scripts/check-i18n.ts``; the Odoo addon speaks a
different format (gettext ``.po`` instead of a typed TS catalog), so it needs
its own guard. Without one, the translation file rots silently: a string is
added to a view or a ``ValidationError``, nobody adds it to ``i18n/ar.po``, and
Arabic users get English mid-sentence with no test failing anywhere.

This checker extracts every translatable term straight from the addon sources
and compares it with the catalog:

``_("...")`` in Python (including implicitly concatenated literals),
``string=`` / ``help=`` / ``placeholder=`` / ``confirm=`` / ``title=`` in XML,
and ``_t("...")`` in JavaScript.

It then proves, for every catalog entry:

* the message id exists in the source (no stale entries);
* every source term has an entry (no untranslated gaps);
* no entry is empty, duplicated, or left identical to English by accident;
* ``%s`` / ``%d`` / ``%(name)s`` placeholders survive translation — a dropped
  placeholder is a runtime ``TypeError`` in Odoo, not a cosmetic problem;
* boundary whitespace is preserved, because several messages are fragments
  that get concatenated with more text.

Runs on the Python standard library alone, so it works with no Node
toolchain and no Odoo installation:

    python3 scripts/check-odoo-translations.py

Exit status is non-zero when any of these invariants break.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ADDON = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway"
CATALOG = ADDON / "i18n" / "ar.po"

# Attributes Odoo exports from views as translatable terms.
XML_ATTRS = ("string", "help", "placeholder", "confirm", "title")

# Literals that are identical in every language: URLs and code samples. The
# checker must not demand a translation for these.
TECHNICAL_TERMS = frozenset(
    {
        "https://print.example.com",
        "e.g. [('state', '=', 'done')]",
        "e.g. ^XA^FO50,50^ADN,36,20^FD{name}^FS^XZ",
    }
)

STRING = r'(?:"""(?:.|\n)*?"""|\'\'\'(?:.|\n)*?\'\'\'|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')'
# `_("first" "second")` — Python joins adjacent literals before `_()` sees them,
# so the extractor has to do the same to produce the real message id.
CONCATENATION = rf"({STRING}(?:\s*{STRING})*)"

# `%(name)s`, `%s`, `%d` — Odoo formats these after translation.
PLACEHOLDER = re.compile(r"%(?:\([A-Za-z_][A-Za-z0-9_]*\))?[sd]")

ARABIC = re.compile(r"[\u0600-\u06FF]")


def unquote(literal_blob: str) -> str:
    """Undo Python string literal syntax on a (possibly concatenated) blob."""
    parts = re.findall(STRING, literal_blob)
    out: list[str] = []
    for part in parts:
        quote = part[:3] if part[:3] in ('"""', "'''") else part[0]
        body = part[len(quote) : -len(quote)]
        out.append(re.sub(r"\\(.)", lambda m: "\n" if m.group(1) == "n" else ("\t" if m.group(1) == "t" else m.group(1)), body))
    return "".join(out)


def extract_terms() -> dict[str, str]:
    """Map every translatable term to the file it was found in."""
    terms: dict[str, str] = {}

    def add(term: str, path: Path) -> None:
        if term:
            terms.setdefault(term, str(path.relative_to(ADDON)))

    for path in sorted(ADDON.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r"\b_\(\s*" + CONCATENATION, source):
            add(unquote(match.group(1)), path)

    for path in sorted(ADDON.rglob("*.xml")):
        source = path.read_text(encoding="utf-8")
        for attr in XML_ATTRS:
            for match in re.finditer(attr + r'="([^"]*)"', source):
                add(match.group(1).strip(), path)

    for path in sorted(ADDON.rglob("*.js")):
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r'_t\(\s*"((?:[^"\\]|\\.)*)"', source):
            add(match.group(1), path)

    return terms


def unescape(po_text: str) -> str:
    """Undo gettext escaping inside a quoted ``.po`` string."""
    out: list[str] = []
    index = 0
    while index < len(po_text):
        char = po_text[index]
        if char == "\\" and index + 1 < len(po_text):
            nxt = po_text[index + 1]
            out.append({"n": "\n", "t": "\t", "\\": "\\", '"': '"'}.get(nxt, nxt))
            index += 2
        else:
            out.append(char)
            index += 1
    return "".join(out)


def parse_catalog(text: str) -> list[tuple[str, str]]:
    """Minimal gettext reader: returns (msgid, msgstr) pairs, header excluded."""
    entries: list[tuple[str, str]] = []
    current: dict[str, str] = {}
    field = ""

    def flush() -> None:
        if current.get("id") is not None and current.get("str") is not None:
            entries.append((current["id"], current["str"]))
        current.clear()

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        header_match = re.match(r'^(msgid|msgstr)\s+"((?:[^"\\]|\\.)*)"$', stripped)
        if header_match:
            keyword, value = header_match.group(1), unescape(header_match.group(2))
            if keyword == "msgid":
                flush()
                current["id"] = value
                field = "id"
            else:
                current["str"] = value
                field = "str"
            continue
        continuation = re.match(r'^"((?:[^"\\]|\\.)*)"$', stripped)
        if continuation and field:
            current[field] += unescape(continuation.group(1))
    flush()
    return [(msgid, msgstr) for msgid, msgstr in entries if msgid]


def main() -> int:
    failures: list[str] = []
    fail = failures.append

    print(f"addon        : {ADDON}")
    print(f"catalog      : {CATALOG.relative_to(ADDON)}")
    if not CATALOG.exists():
        print(f"\nFAIL  no translation catalog at {CATALOG}")
        return 1

    terms = extract_terms()
    catalog = parse_catalog(CATALOG.read_text(encoding="utf-8"))
    catalog_ids = {msgid for msgid, _ in catalog}

    print(f"source terms : {len(terms)}")
    print(f"catalog      : {len(catalog)} entries")
    print()

    missing = sorted(set(terms) - catalog_ids)
    if missing:
        fail(f"{len(missing)} source term(s) have no catalog entry, e.g. {missing[0]!r}")
    stale = sorted(catalog_ids - set(terms))
    if stale:
        fail(f"{len(stale)} catalog entr(y/ies) match no source term, e.g. {stale[0]!r}")

    if len(catalog) != len(catalog_ids):
        fail(f"{len(catalog) - len(catalog_ids)} duplicate message id(s)")

    for msgid, msgstr in catalog:
        if not msgstr.strip():
            fail(f"empty translation: {msgid!r}")
            continue
        if msgid in TECHNICAL_TERMS:
            continue
        if msgid == msgstr:
            fail(f"translation is identical to English: {msgid!r}")
        if not ARABIC.search(msgstr):
            fail(f"translation contains no Arabic text: {msgid!r}")
        for placeholder in PLACEHOLDER.findall(msgid):
            if placeholder not in msgstr:
                fail(f"placeholder {placeholder} lost in translation of {msgid!r}")
                break
        for placeholder in PLACEHOLDER.findall(msgstr):
            if placeholder not in msgid:
                fail(f"translation of {msgid!r} invents placeholder {placeholder}")
                break
        if msgid != msgid.strip() and msgstr == msgstr.strip():
            fail(f"boundary whitespace lost in translation of {msgid!r}")

    # The gettext header is the first block: `msgid ""` / `msgstr ""` followed
    # by metadata lines, terminated by the first blank line.
    header = CATALOG.read_text(encoding="utf-8").split("\n\n", 1)[0]
    if "charset=UTF-8" not in header:
        fail("catalog header does not declare charset=UTF-8")
    if '"Language: ar\\n"' not in header and '"Language: ar"' not in header:
        fail("catalog header does not declare Language: ar")
    if "nplurals=6" not in header:
        fail("catalog header is missing the Arabic Plural-Forms rule (nplurals=6)")

    for failure in failures:
        print(f"  FAIL  {failure}")
    if failures:
        print(f"\n{len(failures)} translation problem(s).")
        return 1
    print("OK: the Odoo addon catalog is complete and consistent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
