#!/usr/bin/env python3
"""Copy, catalog and design-token checks for the Gateway and Desktop UI.

`scripts/check-i18n.ts` remains the canonical catalog checker and runs under
`npm run i18n:check`. It needs `tsx`/`node_modules`, which are unavailable in a
bare checkout and in CI steps that only install Python. This script re-implements
the same guarantees dependency-free and adds two UI-level checks that no existing
script covers:

  1. Hard-coded English copy in TSX — JSX text runs and presentation props that
     bypass `t()` / `tc()`. Any hit is a translation gap: the Arabic interface
     renders English.
  2. Contrast of the text/status tokens against every surface the product paints.
     WCAG 2.2 SC 1.4.3 needs 4.5:1 for normal text and SC 1.4.11 needs 3:1 for
     control boundaries and status indicators that carry meaning by colour.
  3. Utility classes that reference a design token the theme does not define
     (`rounded-sg` before the token existed, `text-ink-5`, `bg-surface-9`, …).
     Tailwind emits nothing for those, so the element silently loses the border
     radius, colour or size the author intended.

Usage:  python3 scripts/check-ui-copy.py [--verbose]
Exit code 0 = clean, 1 = at least one finding.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CATALOGS = {"en": SRC / "i18n/messages/en.ts", "ar": SRC / "i18n/messages/ar.ts"}
GLOBALS = SRC / "app/globals.css"
CATEGORIES = ("zero", "one", "two", "few", "many", "other")

verbose = "--verbose" in sys.argv
findings: list[str] = []
notes: list[str] = []


def report(kind: str, where: str, message: str) -> None:
    findings.append(f"{kind}  {where}: {message}")


# ---------------------------------------------------------------------------
# 1. Catalogs
# ---------------------------------------------------------------------------

PAIR = re.compile(r'^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$', re.M)


def read_catalog(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    body = text.split("export const", 1)[-1]
    out = {key: value for key, value in PAIR.findall(body)}
    if not out:
        raise SystemExit(f"could not parse catalog {path}")
    return out


def placeholders(message: str) -> list[str]:
    return sorted(re.findall(r"\{(\w+)\}", message))


def check_catalogs() -> None:
    en = read_catalog(CATALOGS["en"])
    ar = read_catalog(CATALOGS["ar"])
    if len(en) != len(set(en)):
        report("CATALOG", "en", "duplicate keys")
    missing = sorted(set(en) - set(ar))
    unknown = sorted(set(ar) - set(en))
    for key in missing:
        report("CATALOG", "ar", f'missing key "{key}"')
    for key in unknown:
        report("CATALOG", "ar", f'unknown key "{key}" (not in en)')

    for locale, catalog in (("ar", ar), ("en", en)):
        for key, value in catalog.items():
            if not value.strip():
                report("CATALOG", locale, f'"{key}" is empty')
            source = en.get(key)
            if source is None:
                continue
            wanted, got = placeholders(source), placeholders(value)
            if wanted == got:
                continue
            # Singular/dual Arabic forms may write the numeral as a word.
            if key.rsplit(".", 1)[-1] in ("one", "two"):
                if [p for p in wanted if p != "count"] != [p for p in got if p != "count"]:
                    report("CATALOG", locale, f'"{key}" loses a non-count placeholder')
                continue
            report(
                "CATALOG",
                locale,
                f'"{key}" placeholders {got or "(none)"} != en {wanted or "(none)"}',
            )

    for catalog_name, catalog in (("en", en), ("ar", ar)):
        families: dict[str, set[str]] = {}
        for key in catalog:
            head, _, tail = key.rpartition(".")
            if tail in CATEGORIES and head:
                families.setdefault(head, set()).add(tail)
        for base, categories in families.items():
            if "other" not in categories:
                report("CATALOG", catalog_name, f'count family "{base}" has no .other fallback')
    notes.append(f"catalogs: en {len(en)} keys, ar {len(ar)} keys")


# ---------------------------------------------------------------------------
# 2. Hard-coded UI copy
# ---------------------------------------------------------------------------

JSX_TEXT = re.compile(r"^\s*(?!//|\*|/\*)([A-Z][A-Za-z0-9][^<>{}`\"()\[\]]{25,200})$")
TEMPLATE_PROP = re.compile(
    r"\b(title|label|description|subtitle|placeholder|aria-label|eyebrow|hint|summary)"
    r"=\{\s*`([^`]*\w[^`]*)`"
)
# JSX text that mixes interpolations with words: `{count} of {total} ready`.
INTERPOLATION = re.compile(r"\{[^{}]*\}")
TAG = re.compile(r"</?[A-Za-z][^<>]*>")
WORD_RUN = re.compile(r"\b[A-Za-z][A-Za-z'’.,-]*(?:[ ]+[A-Za-z][A-Za-z'’.,-]*){1,}\b")
# A utility-class fragment (`border-b border-edge-subtle`) is not copy.
UTILITY_TOKEN = re.compile(r"^[a-z]+-[a-z0-9][a-z0-9/-]*$")
# Product and protocol names are literal in both locales by design (a translated
# brand or a wire protocol is no longer the same name).
BRAND_LITERALS = ("Yaseir Print Manager", "Yaseir", "Odoo", "Gateway", "Windows", "Stripe")
# Cast and keyword fragments that survive interpolation stripping.
CODE_LEADERS = ("as ", "typeof ", "keyof ", "in ", "instanceof ", "is ", "readonly ")
CODE_STATEMENT_HEADS = (
    "import ", "export ", "function ", "const ", "let ", "var ", "type ", "interface ",
    "return ", "if ", "else", "for ", "while ", "switch ", "case ", "default:", "await ",
    "throw ", "declare ", "async ", "class ", "//", "*", "/*", "}",
)
ALLOWED_TEMPLATE_WORDS = re.compile(r"^(?:\$\{[^}]*\}|[\s.,:·—/×+()\-])+$")


COMMENT_RE = re.compile(r"/\*.*?\*/|(?<![\w:/])//[^\n]*", re.S)


def strip_comments(text: str) -> str:
    """Blank out comments while preserving line numbers."""
    return COMMENT_RE.sub(lambda m: "\n" * m.group(0).count("\n") + " ", text)


def looks_like_english(snippet: str) -> bool:
    words = re.findall(r"[A-Za-z]{2,}", snippet)
    return len(words) >= 3


def check_hardcoded_copy() -> None:
    for path in sorted(SRC.rglob("*.tsx")):
        text = strip_comments(path.read_text(encoding="utf-8"))
        rel = path.relative_to(ROOT)
        for match in TEMPLATE_PROP.finditer(text):
            body = match.group(2)
            if ALLOWED_TEMPLATE_WORDS.match(body):
                continue
            if looks_like_english(re.sub(r"\$\{[^}]*\}", " ", body)):
                line = text[: match.start()].count("\n") + 1
                report("COPY", f"{rel}:{line}", f"literal text in `{match.group(1)}` prop")
        for line_no, line_text in enumerate(text.split("\n"), 1):
            # Text nodes that contain interpolations stay invisible to the
            # line-based pass, so strip the interpolations and inspect only the
            # characters that sit between a `>` and the next `<` on that line.
            if not line_text.strip().startswith(("//", "*", "/*")):
                without_expr = INTERPOLATION.sub(" ", line_text)
                for span in re.findall(r">([^<>]*)<", without_expr):
                    for run in WORD_RUN.finditer(span):
                        phrase = run.group(0)
                        if phrase.startswith(BRAND_LITERALS + CODE_LEADERS) or UTILITY_TOKEN.match(phrase.split()[0]):
                            continue
                        report(
                            "COPY",
                            f"{rel}:{line_no}",
                            f"JSX text bypasses t(): {phrase[:64]!r}",
                        )
            # A text line made only of interpolations plus words ("{used} of
            # {limit} print jobs used") carries copy but no tags.
            stripped_line = line_text.strip()
            if (
                "{" in line_text
                and not any(ch in line_text for ch in ";()=<>")
                and not stripped_line.startswith(CODE_STATEMENT_HEADS)
            ):
                for run in WORD_RUN.finditer(INTERPOLATION.sub(" ", line_text)):
                    phrase = run.group(0)
                    if phrase.startswith(BRAND_LITERALS + CODE_LEADERS) or UTILITY_TOKEN.match(phrase.split()[0]):
                        continue
                    report("COPY", f"{rel}:{line_no}", f"JSX text bypasses t(): {phrase[:64]!r}")
            hit = JSX_TEXT.match(line_text)
            if not hit:
                continue
            snippet = hit.group(1).strip()
            if snippet.startswith(("//", "*", "/*")):
                continue
            if not looks_like_english(snippet):
                continue
            if re.search(r"[=;]$|=>|\b(return|const|import|export|expect|assert)\b", snippet):
                continue
            report("COPY", f"{rel}:{line_no}", f"JSX text bypasses t(): {snippet[:64]!r}")


# ---------------------------------------------------------------------------
# 3. Design tokens referenced by utility classes
# ---------------------------------------------------------------------------

COLOR_UTILITY = re.compile(
    r"(?:^|[\s:\"'])((?:bg|text|border|ring|divide|outline|fill|stroke|from|to|via|accent)"
    r"-([a-z][a-z0-9-]*?))(?:/\d{1,3})?(?=[\s\"'`]|$)"
)
RADIUS_UTILITY = re.compile(r"(?:^|[\s:\"'])(rounded(?:-[a-z0-9]+)?)(?=[\s\"'`]|$)")

# Suffixes that belong to a non-colour utility with the same prefix. Tailwind
# resolves them from its own scales, so they are not design-token references.
NON_COLOR_SUFFIXES = {
    "text": {
        "xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
        "start", "end", "center", "left", "right", "justify", "wrap", "nowrap", "balance", "pretty",
        "ellipsis", "clip",
    },
    "border": {"t", "b", "l", "r", "s", "e", "x", "y", "solid", "dashed", "dotted", "double", "hidden",
               "none", "collapse", "separate", "spacing"},
    "bg": {"none", "cover", "contain", "center", "top", "bottom", "left", "right", "fixed", "local",
           "scroll", "repeat", "no-repeat", "clip", "origin", "blend", "linear", "radial", "conic",
           "auto", "clip-border", "clip-text"},
    "ring": {"inset", "offset"},
    "divide": {"x", "y", "solid", "dashed", "dotted", "double", "none"},
    "outline": {"none", "hidden", "solid", "dashed", "dotted", "double", "offset"},
    "fill": {"none", "current"},
    "stroke": {"none", "current"},
    "shadow": {"xs", "sm", "md", "lg", "xl", "2xl", "none", "inner", "card", "card-hover", "inset"},
}


def is_structural(utility: str, name: str) -> bool:
    prefix = utility.split("-", 1)[0]
    if name.isdigit():
        return True
    if name in NON_COLOR_SUFFIXES.get(prefix, set()):
        return True
    # Multi-word structural suffixes: bg-linear-to-r, outline-offset-2, ring-offset-1…
    for suffix in sorted(NON_COLOR_SUFFIXES.get(prefix, set()), key=len, reverse=True):
        if name == suffix or name.startswith(f"{suffix}-"):
            return True
    return False


def theme_tokens() -> tuple[set[str], set[str], set[str]]:
    css = GLOBALS.read_text(encoding="utf-8")
    theme = css.split("@theme", 1)[1].split("\n}", 1)[0]
    colors = set(re.findall(r"--color-([a-z0-9-]+):", theme))
    radius = set(re.findall(r"--radius-([a-z0-9-]+):", theme))
    # Hand-written component/utility classes (`.text-eyebrow`, `.kbd`, `.card`…) live
    # outside @theme and are equally valid on an element.
    custom = set(re.findall(r"^\s*\.([a-z][a-z0-9-]*)\s*(?:[,{]|::?[a-z-]+)", css, re.M))
    return colors | {"black", "white", "transparent", "current", "inherit"}, radius, custom


def check_tokens() -> None:
    colors, radius, custom = theme_tokens()
    for path in sorted(SRC.rglob("*.tsx")):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for line_no, line in enumerate(text.split("\n"), 1):
            for match in RADIUS_UTILITY.finditer(line):
                token = match.group(1)
                if token in ("rounded", "rounded-full", "rounded-none"):
                    continue
                name = token.split("-", 1)[1]
                if name in radius or token in custom:
                    continue
                if name not in radius:
                    report("TOKEN", f"{rel}:{line_no}", f"`{token}` — no --radius-{name} in @theme")
            for match in COLOR_UTILITY.finditer(line):
                utility, name = match.group(1), match.group(2)
                if name in colors or utility in custom or name in custom or is_structural(utility, name):
                    continue
                report("TOKEN", f"{rel}:{line_no}", f"`{utility}` — no --color-{name} in @theme")


SURFACES = ("bg", "surface", "surface-2", "surface-3", "surface-accent", "brand-subtle")
TEXT_TOKENS = ("text", "text-2", "text-3", "text-4")
STATUS_TOKENS = ("ok", "warn", "bad", "info", "notice-text")
# Only the form-control boundary is checked: a dialog, drawer or tooltip edge is
# not the sole identifier of an interactive control (its label and surface are),
# so the 3:1 boundary rule of SC 1.4.11 applies to `--control-border`.
CONTROL_TOKENS = ("control-border",)


def relative_luminance(hex_color: str) -> float:
    value = hex_color.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    channels = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast_ratio(a: str, b: str) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def theme_blocks() -> dict[str, dict[str, str]]:
    css = GLOBALS.read_text(encoding="utf-8")
    blocks: dict[str, dict[str, str]] = {}
    for name, selector in (("light", ":root {"), ("dark", ':root[data-theme="dark"] {')):
        start = css.index(selector)
        body = css[start + len(selector) :]
        body = body[: body.index("\n}")]
        blocks[name] = dict(re.findall(r"--([\w-]+):\s*([^;]+);", body))
    return blocks


def check_contrast() -> None:
    for theme, tokens in theme_blocks().items():
        for token in TEXT_TOKENS:
            color = tokens.get(token, "").strip()
            if not color.startswith("#"):
                continue
            for surface in SURFACES:
                bg = tokens.get(surface, "").strip()
                if not bg.startswith("#"):
                    continue
                ratio = contrast_ratio(color, bg)
                if ratio < 4.5:
                    report(
                        "CONTRAST",
                        theme,
                        f"--{token} on --{surface} is {ratio:.2f}:1 (needs 4.5:1)",
                    )
        for token in STATUS_TOKENS:
            color = tokens.get(token, "").strip()
            if not color.startswith("#"):
                continue
            for surface in ("surface", "surface-2"):
                bg = tokens.get(surface, "").strip()
                if not bg.startswith("#"):
                    continue
                ratio = contrast_ratio(color, bg)
                if ratio < 4.5:
                    report("CONTRAST", theme, f"--{token} on --{surface} is {ratio:.2f}:1 (needs 4.5:1)")
        # Solid fills carry white label text in buttons, timeline steps and
        # step markers, so the pair must clear 4.5:1 as well.
        for token in ("brand-solid", "success-solid", "danger-solid", "warning-solid"):
            color = tokens.get(token, "").strip()
            if not color.startswith("#"):
                continue
            ratio = contrast_ratio("#ffffff", color)
            if ratio < 4.5:
                report("CONTRAST", theme, f"white label on --{token} is {ratio:.2f}:1 (needs 4.5:1)")
        # Notice surfaces paint their own text/icon on --notice-bg.
        for pair, needed in (("notice-text", 4.5), ("notice-icon", 3.0)):
            color = tokens.get(pair, "").strip()
            bg = tokens.get("notice-bg", "").strip()
            if color.startswith("#") and bg.startswith("#"):
                ratio = contrast_ratio(color, bg)
                if ratio < needed:
                    report("CONTRAST", theme, f"--{pair} on --notice-bg is {ratio:.2f}:1 (needs {needed}:1)")
        for token in CONTROL_TOKENS:
            color = tokens.get(token, "").strip()
            if not color.startswith("#"):
                continue
            ratio = contrast_ratio(color, tokens.get("surface", "#ffffff").strip())
            if ratio < 3:
                report("CONTRAST", theme, f"--{token} on --surface is {ratio:.2f}:1 (needs 3:1)")


def main() -> int:
    check_catalogs()
    check_hardcoded_copy()
    check_tokens()
    check_contrast()
    for note in notes:
        print(note)
    if not findings:
        print("OK: catalogs complete, no hard-coded UI copy, every design token defined")
        return 0
    for finding in findings:
        print(f"  {finding}")
    print(f"{len(findings)} finding(s)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
