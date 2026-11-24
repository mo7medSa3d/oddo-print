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
import ast
import xml.etree.ElementTree as ET
from collections import Counter
import sys
from pathlib import Path

ADDON = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway"
CATALOG = ADDON / "i18n" / "ar.po"

# Attributes Odoo exports from views as translatable terms.
XML_ATTRS = ("string", "help", "placeholder", "confirm", "title", "aria-label")

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


class TranslationTreeBuilder(ET.TreeBuilder):
    """Translation source has no DTD; reject it before entity expansion.

    This is an XML parser event, so UTF-16 declarations cannot bypass the
    policy as they could a raw-byte search. Standard XML escapes still work.
    """

    def doctype(self, name, pubid, system):
        raise ValueError("DTD declarations are not allowed in translation XML")


def unquote(literal_blob: str) -> str:
    """Undo Python string literal syntax on a (possibly concatenated) blob."""
    parts = re.findall(STRING, literal_blob)
    out: list[str] = []
    for part in parts:
        quote = part[:3] if part[:3] in ('"""', "'''") else part[0]
        body = part[len(quote) : -len(quote)]
        out.append(re.sub(r"\\(.)", lambda m: "\n" if m.group(1) == "n" else ("\t" if m.group(1) == "t" else m.group(1)), body))
    return "".join(out)


def extract_occurrences(addon: Path = ADDON) -> dict[str, set[str]]:
    """Extract source terms and the importable Odoo 19 occurrence for each."""
    terms: dict[str, set[str]] = {}
    def add(term, occurrence):
        if isinstance(term, str) and term and any(ch.isalpha() for ch in term):
            terms.setdefault(term, set()).add(occurrence)
    def literal(node, constants):
        if isinstance(node, ast.Name):
            node = constants.get(node.id, node)
        if isinstance(node, ast.Call) and node.args and (getattr(node.func, "id", "") == "_" or getattr(node.func, "attr", "") == "_"):
            node = node.args[0]
        try:
            return ast.literal_eval(node)
        except (ValueError, TypeError, SyntaxError):
            return None
    # Odoo 19 module metadata is translated through ir.module.module.
    # Dropping static/description/index.html allows description_html to use
    # the translated manifest description instead of English-only markup.
    manifest_path = addon / "__manifest__.py"
    if manifest_path.exists():
        manifest_tree = ast.parse(manifest_path.read_text(encoding="utf-8"))
        manifest = ast.literal_eval(manifest_tree.body[0].value)
        for manifest_key, model_field in (
            ("name", "shortdesc"), ("summary", "summary"), ("description", "description"),
        ):
            add(manifest.get(manifest_key), f"model:ir.module.module,{model_field}:base.module_{addon.name}")
    for path in sorted(addon.rglob("*.py")):
        if "tests" in path.relative_to(addon).parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        constants = {n.targets[0].id: n.value for n in tree.body if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)}
        code = f"code:addons/{addon.name}/{path.relative_to(addon).as_posix()}:0"
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and n.args and (getattr(n.func, "id", "") == "_" or getattr(n.func, "attr", "") == "_"):
                add(literal(n.args[0], constants), code)
        for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
            attrs = {n.targets[0].id: n.value for n in cls.body if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)}
            model = literal(attrs.get("_name") or attrs.get("_inherit"), constants)
            if not isinstance(model, str):
                continue
            model_id = model.replace(".", "_")
            if "_name" in attrs:
                add(literal(attrs.get("_description"), constants), f"model:ir.model,name:{addon.name}.model_{model_id}")
            for name, node in attrs.items():
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or getattr(node.func.value, "id", "") != "fields":
                    continue
                kw = {k.arg: literal(k.value, constants) for k in node.keywords if k.arg}
                # Relational/selection first positional argument is not a label.
                index = 1 if node.func.attr in {"Many2one", "One2many", "Many2many", "Selection", "Reference"} else 0
                label = kw.get("string") or (literal(node.args[index], constants) if len(node.args) > index else None) or name.replace("_", " ").capitalize()
                field_id = f"{addon.name}.field_{model_id}__{name}"
                add(label, f"model:ir.model.fields,field_description:{field_id}")
                add(kw.get("help"), f"model:ir.model.fields,help:{field_id}")
                selection = kw.get("selection") or (literal(node.args[0], constants) if node.func.attr in {"Selection", "Reference"} and node.args else None)
                if isinstance(selection, (list, tuple)):
                    for item in selection:
                        if isinstance(item, (list, tuple)) and len(item) == 2:
                            value, label = item
                            add(label, f"model:ir.model.fields.selection,name:{addon.name}.selection__{model_id}__{name}__{str(value).replace('.', '_')}")
    def xml_terms(node, ref, disabled=False):
        disabled = disabled or node.attrib.get("t-translation") == "off"
        if disabled or node.tag in {"script", "style"}:
            return
        for attr in XML_ATTRS:
            add(node.attrib.get(attr, "").strip(), ref)
        add((node.text or "").strip(), ref)
        for child in node:
            xml_terms(child, ref, disabled)
            add((child.tail or "").strip(), ref)
    for path in sorted(addon.rglob("*.xml")):
        tree = ET.parse(path, parser=ET.XMLParser(target=TranslationTreeBuilder())).getroot()
        code = f"code:addons/{addon.name}/{path.relative_to(addon).as_posix()}:0"
        if "static" in path.relative_to(addon).parts:
            xml_terms(tree, code)
            continue
        for record in tree.iter("record"):
            xmlid = record.attrib.get("id", "")
            xmlid = xmlid if "." in xmlid else f"{addon.name}.{xmlid}"
            model = record.attrib.get("model", "")
            for field in record.findall("field"):
                name = field.attrib.get("name", "")
                if name == "arch" and model == "ir.ui.view":
                    for child in field:
                        xml_terms(child, f"model_terms:ir.ui.view,arch_db:{xmlid}")
                elif name == "help" and model == "ir.actions.act_window" and len(field):
                    # Include visible HTML help content in the same translation
                    # contract as the rest of the Odoo 19 customer interface.
                    xml_terms(field, f"model_terms:ir.actions.act_window,help:{xmlid}")
                elif name in {"name", "help"} and model in {"ir.actions.act_window", "ir.actions.client", "ir.actions.report", "ir.ui.menu", "res.groups", "ir.module.category"}:
                    add((field.text or "").strip(), f"model:{model},{name}:{xmlid}")
        for template in tree.iter("template"):
            xmlid = template.attrib.get("id", "")
            xmlid = xmlid if "." in xmlid else f"{addon.name}.{xmlid}"
            xml_terms(template, f"model_terms:ir.ui.view,arch_db:{xmlid}")
        for menu in tree.iter("menuitem"):
            xmlid = menu.attrib.get("id", "")
            xmlid = xmlid if "." in xmlid else f"{addon.name}.{xmlid}"
            add(menu.attrib.get("name"), f"model:ir.ui.menu,name:{xmlid}")
    for path in sorted(addon.rglob("*.js")):
        code = f"code:addons/{addon.name}/{path.relative_to(addon).as_posix()}:0"
        for match in re.finditer(r'_t\(\s*"((?:[^"\\]|\\.)*)"', path.read_text(encoding="utf-8")):
            add(unescape(match.group(1)), code)
    return terms


def extract_terms() -> dict[str, str]:
    return {term: sorted(refs)[0] for term, refs in extract_occurrences().items()}


_DEFAULT_EXTRACT_TERMS = extract_terms


def catalog_blocks(text: str):
    """Yield entry blocks, including valid entries without a blank separator."""
    lines: list[str] = []
    has_entry = False
    has_translation = False
    for line in text.splitlines():
        if ((line.startswith("#") and has_translation)
                or (line.startswith("msgid ") and has_entry)
                or (not line.strip() and has_translation)):
            yield "\n".join(lines)
            lines = []
            has_entry = has_translation = False
        lines.append(line)
        if line.startswith("msgid "):
            has_entry = True
        elif line.startswith("msgstr "):
            has_translation = True
    if lines:
        yield "\n".join(lines)


def catalog_occurrences(text: str) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for block in catalog_blocks(text):
        entries = parse_catalog(block)
        refs = {ref for line in block.splitlines() if line.startswith("#:") for ref in line[2:].split()}
        for msgid, _ in entries:
            result.setdefault(msgid, set()).update(refs)
    return result


OCC_CODE_RE = re.compile(r"code:[\w/.]+:[0-9]+")
OCC_MODEL_RE = re.compile(r"model(?:_terms)?:[\w.]+,[\w]+:[\w]+\.[^ ]+")
OCC_PY_RE = re.compile(r"code:[\w/.]+\.py:[0-9]+")
OCC_JS_RE = re.compile(r"code:[\w/.]+/static/[\w/.]+\.(?:js|xml):[0-9]+")
PO_HEADER_RE = re.compile(r'^(msgid|msgstr)\s+"((?:[^"\\]|\\.)*)"$')
PO_CONT_RE = re.compile(r'^"((?:[^"\\]|\\.)*)"$')


def valid_occurrence(ref: str) -> bool:
    return bool(OCC_CODE_RE.fullmatch(ref) or OCC_MODEL_RE.fullmatch(ref))


def catalog_marker_failures(text: str) -> list[tuple[str, str]]:
    """Odoo 19 ignores code terms without its extracted language marker.

    Typed occurrences alone are insufficient. Shared Python/JavaScript terms
    need both markers, whereas model/model_terms entries need neither.
    """
    failures: list[tuple[str, str]] = []
    for block in catalog_blocks(text):
        refs = {ref for line in block.splitlines() if line.startswith("#:") for ref in line[2:].split()}
        comments = {line[2:].strip() for line in block.splitlines() if line.startswith("#.")}
        required = []
        if any(OCC_PY_RE.fullmatch(ref) for ref in refs):
            required.append("odoo-python")
        if any(OCC_JS_RE.fullmatch(ref) for ref in refs):
            required.append("odoo-javascript")
        if not required:
            continue
        for msgid, _msgstr in parse_catalog(block):
            failures.extend((msgid, marker) for marker in required if marker not in comments)
    return failures


def unescape(po_text: str) -> str:
    """Undo gettext escaping inside a quoted ``.po`` string."""
    if "\\" not in po_text:
        return po_text
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
        header_match = PO_HEADER_RE.match(stripped)
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
        continuation = PO_CONT_RE.match(stripped)
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

    expected_refs = extract_occurrences()
    terms = (
        {term: sorted(refs)[0] for term, refs in expected_refs.items()}
        if extract_terms is _DEFAULT_EXTRACT_TERMS
        else extract_terms()
    )
    catalog_text = CATALOG.read_text(encoding="utf-8")
    catalog = parse_catalog(catalog_text)
    catalog_ids = {msgid for msgid, _ in catalog}
    actual_refs = catalog_occurrences(catalog_text)
    for msgid, marker in catalog_marker_failures(catalog_text):
        fail(f"missing Odoo 19 code marker {marker!r} for {msgid!r}")
    for msgid, refs in actual_refs.items():
        for ref in refs:
            if not valid_occurrence(ref):
                fail(f"unimportable Odoo occurrence {ref!r} for {msgid!r}")
        required = expected_refs.get(msgid, set())
        if required - refs:
            fail(f"missing typed Odoo occurrence for {msgid!r}: {sorted(required - refs)[0]}")

    print(f"source terms : {len(terms)}")
    print(f"catalog      : {len(catalog)} entries")
    print()

    missing = sorted(set(terms) - catalog_ids)
    for msgid in missing:
        fail(f"source term has no catalog entry: {msgid!r}")
    stale = sorted(catalog_ids - set(terms))
    for msgid in stale:
        fail(f"catalog entry matches no source term: {msgid!r}")

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
        if Counter(PLACEHOLDER.findall(msgid)) != Counter(PLACEHOLDER.findall(msgstr)):
            fail(f"placeholder counts differ in translation of {msgid!r}")
        if msgid != msgid.strip() and msgstr == msgstr.strip():
            fail(f"boundary whitespace lost in translation of {msgid!r}")

    # The gettext header is the first block: `msgid ""` / `msgstr ""` followed
    # by metadata lines, terminated by the first blank line.
    header = catalog_text.split("\n\n", 1)[0]
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
