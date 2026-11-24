#!/usr/bin/env python3
"""Require every source-defined addon test exactly once in a native Odoo log.

Odoo 19's stats count includes class fixtures, and its final result string omits
skips. Neither a minimum stats count nor a zero-failure summary establishes that
the complete addon suite executed. This gate checks imports, exact method IDs,
the actual result count, and explicit skip/failure records without importing
Odoo or executing the test modules.

The supported source shape is deliberately explicit: top-level classes directly
extending Odoo TransactionCase, with ordinary undecorated test methods. A class
may use the imported, static Odoo @tagged('post_install', '-at_install') phase
selector; every method still has to execute exactly once. Other decorators,
parametrization and inheritance require a deliberate inventory extension.
"""
import argparse
import ast
from collections import Counter
import json
from pathlib import Path
import re
import sys


PREFIX = "odoo.addons.print_gateway.tests."
START = re.compile(
    r"\b(odoo\.addons\.print_gateway\.tests\.\w+): Starting "
    r"(\w+\.test_\w+) \.\.\.\s*$"
)
RESULT = re.compile(
    r"\bodoo\.tests\.result: (\d+) failed, (\d+) error\(s\) of (\d+) tests\b"
)
TEST_RECORD = re.compile(r"\bodoo\.addons\.print_gateway\.tests\.[\w.]+: (.*)$")


def expected_test_ids(tests_dir: Path) -> set[str]:
    """Inventory the complete supported suite and reject ambiguous loading."""
    modules = {path.stem: path for path in tests_dir.glob("test_*.py")}
    nested = set(tests_dir.rglob("test_*.py")) - set(modules.values())
    if not modules or nested:
        raise ValueError("No top-level test modules, or unsupported nested test modules")
    imported = []
    for node in ast.parse((tests_dir / "__init__.py").read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        if not isinstance(node, ast.ImportFrom) or node.level != 1 or node.module is not None:
            raise ValueError("Unsupported test import: use unconditional 'from . import test_module'")
        if any(alias.asname for alias in node.names):
            raise ValueError("Aliased test module imports are unsupported")
        imported.extend(alias.name for alias in node.names)
    if set(imported) != set(modules) or len(imported) != len(set(imported)):
        raise ValueError(
            "Test imports do not match all test modules: "
            f"unimported={sorted(set(modules) - set(imported))}, "
            f"unknown={sorted(set(imported) - set(modules))}, "
            f"duplicates={sorted(name for name, count in Counter(imported).items() if count > 1)}"
        )

    expected = set()
    for module_name, path in sorted(modules.items()):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        transaction_names = {
            alias.asname or alias.name
            for node in tree.body if isinstance(node, ast.ImportFrom)
            and node.module == "odoo.tests.common" and node.level == 0
            for alias in node.names if alias.name == "TransactionCase"
        }
        tagged_imports = [
            (node.module, alias)
            for node in tree.body if isinstance(node, ast.ImportFrom) and node.level == 0
            for alias in node.names if (alias.asname or alias.name) == "tagged"
        ]
        static_odoo_tagged = (
            len(tagged_imports) == 1
            and tagged_imports[0][0] == "odoo.tests"
            and tagged_imports[0][1].name == "tagged"
            and tagged_imports[0][1].asname is None
            and not any(
                isinstance(node, ast.Import)
                and any((alias.asname or alias.name.split(".")[0]) == "tagged" for alias in node.names)
                for node in ast.walk(tree)
            )
            and not any(
                (isinstance(node, ast.Name) and node.id == "tagged" and isinstance(node.ctx, ast.Store))
                or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == "tagged")
                for node in ast.walk(tree)
            )
        )
        supported_methods = set()
        class_names = set()
        count_before = len(expected)
        for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
            methods = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")]
            is_transaction = any(isinstance(base, ast.Name) and base.id in transaction_names for base in cls.bases)
            if not methods and not is_transaction:
                if cls.bases:
                    raise ValueError(f"Unsupported inherited test/helper class: {module_name}.{cls.name}")
                continue  # Ordinary helper classes are not test cases.
            phase_decorator = cls.decorator_list[0] if len(cls.decorator_list) == 1 else None
            supported_phase = (
                static_odoo_tagged and isinstance(phase_decorator, ast.Call)
                and isinstance(phase_decorator.func, ast.Name) and phase_decorator.func.id == "tagged"
                and not phase_decorator.keywords and len(phase_decorator.args) == 2
                and all(isinstance(arg, ast.Constant) and isinstance(arg.value, str) for arg in phase_decorator.args)
                and {arg.value for arg in phase_decorator.args} == {"post_install", "-at_install"}
            )
            if not methods or len(cls.bases) != 1 or not is_transaction or (cls.decorator_list and not supported_phase) or cls.keywords:
                raise ValueError(f"Unsupported test class/inheritance/decorators: {module_name}.{cls.name}")
            if cls.name in class_names:
                raise ValueError(f"Duplicate test class: {module_name}.{cls.name}")
            class_names.add(cls.name)
            for method in methods:
                if isinstance(method, ast.AsyncFunctionDef) or method.decorator_list:
                    raise ValueError(f"Unsupported test method/decorators: {module_name}.{cls.name}.{method.name}")
                test_id = f"{PREFIX}{module_name}.{cls.name}.{method.name}"
                if test_id in expected:
                    raise ValueError(f"Duplicate test method: {test_id}")
                expected.add(test_id)
                supported_methods.add(id(method))
        # Conditional/nested classes, top-level tests and dynamically wrapped
        # functions must not silently vanish from the expected method set.
        all_methods = {id(node) for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")}
        if all_methods != supported_methods or len(expected) == count_before:
            raise ValueError(f"Unsupported or absent test definitions in {module_name}")
    return expected


def verify_test_log(expected: set[str], log: str) -> dict:
    if not expected:
        raise ValueError("An empty expected suite cannot pass")
    started = []
    summaries = []
    for line in log.splitlines():
        record = TEST_RECORD.search(line)
        if record and (
            re.match(r"(?:skipped\b|FAIL:|ERROR:)", record.group(1), re.IGNORECASE)
            or re.search(r"\b(?:ERROR|CRITICAL)\b.*odoo\.addons\.print_gateway\.tests\.", line)
        ):
            raise ValueError("Native addon test log contains a skip, failure or error record")
        start = START.search(line)
        if start:
            started.append(f"{start.group(1)}.{start.group(2)}")
        summary = RESULT.search(line)
        if summary:
            summaries.append(tuple(map(int, summary.groups())))
    counts = Counter(started)
    duplicates = sorted(test_id for test_id, count in counts.items() if count != 1)
    missing = sorted(expected - counts.keys())
    unexpected = sorted(counts.keys() - expected)
    if missing or unexpected or duplicates:
        raise ValueError(
            "Native test IDs differ from source: "
            f"missing={missing[:20]}, unexpected={unexpected[:20]}, duplicates={duplicates[:20]}"
        )
    if summaries != [(0, 0, len(expected))]:
        raise ValueError(f"Expected one complete zero-error result for {len(expected)} tests; found {summaries}")
    return {
        "result": "PASS", "expected_count": len(expected),
        "executed_count": len(started), "skipped": 0, "failures": 0, "errors": 0,
        "module_count": len({test_id.rsplit(".", 2)[0] for test_id in expected}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tests-dir", type=Path, default=Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/tests")
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify_test_log(expected_test_ids(args.tests_dir), args.log.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
