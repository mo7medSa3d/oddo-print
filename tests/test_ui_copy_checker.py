"""Fixture coverage for scripts/check-ui-copy.py catalog parsing (C068).

The legacy single-line regex silently dropped concatenated multi-line values
from coverage, and duplicate keys overwrote each other before the duplicate
check could see them.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_checker():
    spec = importlib.util.spec_from_file_location(
        "check_ui_copy", ROOT / "scripts" / "check-ui-copy.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_catalog(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "messages.ts"
    path.write_text('export const en = {\n' + body + '\n};\n', encoding="utf-8")
    return path


def test_concatenated_multiline_value_is_covered(tmp_path):
    checker = load_checker()
    path = write_catalog(
        tmp_path,
        '  "a.b": "first part " +\n    "second part {name}",\n  "c.d": "plain",\n',
    )
    catalog = checker.read_catalog(path)
    assert catalog == {"a.b": "first part second part {name}", "c.d": "plain"}
    assert checker.placeholders(catalog["a.b"]) == ["name"]


def test_duplicate_keys_are_all_visible_to_detection(tmp_path):
    checker = load_checker()
    path = write_catalog(
        tmp_path,
        '  "dup.key": "first",\n  "other": "x",\n  "dup.key": "second",\n',
    )
    entries = checker.read_catalog_entries(path)
    keys = [key for key, _ in entries]
    assert keys == ["dup.key", "other", "dup.key"]
    assert len(keys) != len(set(keys))
    # Mapping keeps TS object semantics (last wins) for downstream checks.
    assert checker.read_catalog(path)["dup.key"] == "second"


def test_escaped_quotes_do_not_truncate_values(tmp_path):
    checker = load_checker()
    path = write_catalog(tmp_path, '  "q": "say \\"hi\\" {name}",\n')
    assert checker.read_catalog(path) == {"q": 'say "hi" {name}'}


def test_real_catalogs_agree_between_new_and_legacy_parsing():
    checker = load_checker()
    for locale in ("en", "ar"):
        path = ROOT / "src" / "i18n" / "messages" / f"{locale}.ts"
        legacy = {
            key: value
            for key, value in checker.PAIR.findall(
                path.read_text(encoding="utf-8").split("export const", 1)[-1]
            )
        }
        modern = checker.read_catalog(path)
        # Every key the legacy regex saw must parse to the same runtime value;
        # the legacy form keeps backslash escapes raw while the modern parser
        # resolves them (matching TypeScript string semantics). The modern
        # parser may only ADD coverage (concatenated values), never change it.
        for key, value in legacy.items():
            assert modern[key] == value.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\\\", "\\"), key
    assert len(checker.read_catalog(ROOT / "src/i18n/messages/en.ts")) == len(
        checker.read_catalog(ROOT / "src/i18n/messages/ar.ts")
    )


def test_balanced_jsx_expression_stripping_ignores_nested_prop_code():
    checker = load_checker()
    line = (
        '<div>{p.agentName} • '
        '{printerIsStale(p, nowMs) ? <Badge label={t("status.stale")} /> : null}'
        '{printerAgentView(p, nowMs, locale).label}</div>'
    )
    stripped = checker.strip_jsx_expressions(line)
    assert "p, nowMs" not in stripped
    assert "printerAgentView" not in stripped
    assert " • " in stripped


def test_balanced_jsx_expression_stripping_preserves_literal_copy():
    checker = load_checker()
    stripped = checker.strip_jsx_expressions('<div>Sampled {time}</div>')
    assert "Sampled" in stripped
    assert "time" not in stripped
