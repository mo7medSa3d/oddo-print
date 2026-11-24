"""The release gate must reject incomplete or silently skipped Odoo suites."""
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "verify_odoo_test_results", ROOT / "scripts" / "verify-odoo-test-results.py"
)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


@pytest.fixture
def suite(tmp_path):
    (tmp_path / "__init__.py").write_text("from . import test_contract\n")
    (tmp_path / "test_contract.py").write_text(
        "from odoo.tests.common import TransactionCase\n"
        "class TestContract(TransactionCase):\n"
        "    def test_one(self): pass\n"
        "    def test_two(self): pass\n"
    )
    return tmp_path


def native_log(methods=("test_one", "test_two"), count=2, extra=""):
    prefix = "2026-10-24 00:00:00,000 1 INFO test_db "
    lines = [
        prefix + "odoo.addons.print_gateway.tests.test_contract: "
        f"Starting TestContract.{name} ..." for name in methods
    ]
    # Real Odoo stats include setup/teardown class fixtures; never use this
    # inflated count as the number of executed test methods.
    lines += [prefix + "odoo.tests.stats: print_gateway: 260 tests 2.00s 12 queries"]
    lines += [extra] if extra else []
    lines += [prefix + f"odoo.tests.result: 0 failed, 0 error(s) of {count} tests when loading database 'test_db'"]
    return "\n".join(lines)


def test_exact_native_method_ids_and_result_count_pass(suite):
    expected = GATE.expected_test_ids(suite)
    result = GATE.verify_test_log(expected, native_log())
    assert result["expected_count"] == result["executed_count"] == 2


@pytest.mark.parametrize("methods,count", [(("test_one",), 1), (("test_one",), 2), (("test_one", "test_one"), 2), (("test_one", "test_two", "test_three"), 3)])
def test_partial_duplicate_or_unexpected_method_is_rejected(suite, methods, count):
    with pytest.raises(ValueError):
        GATE.verify_test_log(GATE.expected_test_ids(suite), native_log(methods, count))


@pytest.mark.parametrize("message", ["skipped TestContract.test_two : no fixture", "FAIL: TestContract.test_two", "ERROR: TestContract.test_two"])
def test_zero_error_summary_does_not_hide_per_test_skip_or_failure(suite, message):
    log = native_log(extra="INFO test_db odoo.addons.print_gateway.tests.test_contract: " + message)
    with pytest.raises(ValueError):
        GATE.verify_test_log(GATE.expected_test_ids(suite), log)


@pytest.mark.parametrize("change", ["count", "failure", "missing", "duplicate"])
def test_incomplete_or_ambiguous_final_summary_is_rejected(suite, change):
    log = native_log()
    if change == "count":
        log = log.replace("of 2 tests", "of 99 tests")
    elif change == "failure":
        log = log.replace("0 failed", "1 failed")
    elif change == "missing":
        log = "\n".join(log.splitlines()[:-1])
    else:
        log += "\n" + log.splitlines()[-1]
    with pytest.raises(ValueError):
        GATE.verify_test_log(GATE.expected_test_ids(suite), log)


def test_unimported_test_module_cannot_disappear_from_expected_count(suite):
    (suite / "test_hidden.py").write_text((suite / "test_contract.py").read_text())
    with pytest.raises(ValueError, match="import"):
        GATE.expected_test_ids(suite)


@pytest.mark.parametrize("source", [
    "class TestContract(OtherBase):\n    def test_one(self): pass\n",
    "@tagged('post_install')\nclass TestContract(TransactionCase):\n    def test_one(self): pass\n",
    "class TestContract(TransactionCase):\n    @skip('optional')\n    def test_one(self): pass\n",
    "class TestContract(TransactionCase):\n    def test_one(self): pass\n    def test_one(self): pass\n",
    "class TestContract(TransactionCase):\n    async def test_one(self): pass\n",
    "if enabled:\n    class TestContract(TransactionCase):\n        def test_one(self): pass\n",
    "class TestContract(TransactionCase):\n    def test_one(self): pass\nclass Child(TestContract):\n    pass\n",
])
def test_unsupported_or_duplicate_test_definition_fails_closed(suite, source):
    (suite / "test_contract.py").write_text("from odoo.tests.common import TransactionCase\n" + source)
    with pytest.raises(ValueError):
        GATE.expected_test_ids(suite)


def test_real_addon_inventory_is_nonempty_and_includes_every_module():
    expected = GATE.expected_test_ids(ROOT / "odoo_addons" / "print_gateway" / "tests")
    assert expected
    modules = {name.rsplit(".", 2)[0] for name in expected}
    assert len(modules) == len(list((ROOT / "odoo_addons" / "print_gateway" / "tests").glob("test_*.py")))


def test_static_post_install_phase_keeps_every_method_required(suite):
    source = (suite / "test_contract.py").read_text()
    (suite / "test_contract.py").write_text(
        "from odoo.tests import tagged\n" + source.replace(
            "class TestContract", "@tagged('post_install', '-at_install')\nclass TestContract"
        )
    )
    expected = GATE.expected_test_ids(suite)
    assert len(expected) == 2
    assert GATE.verify_test_log(expected, native_log())["executed_count"] == 2
    with pytest.raises(ValueError):
        GATE.verify_test_log(expected, native_log(("test_one",), 1))


@pytest.mark.parametrize("declaration", [
    "@tagged('post_install')",
    "@tagged('post_install', '-at_install', '-standard')",
    "@tagged('post_install', '-at_install', 'optional')",
    "@tagged(*phase_tags)",
    "@tagged('post_install', phase)",
    "@tagged(tags=['post_install', '-at_install'])",
    "@tagged('post_install', '-at_install')\n@skip('optional')",
])
def test_dynamic_or_selectively_disabled_tagged_classes_still_fail_closed(suite, declaration):
    source = (suite / "test_contract.py").read_text()
    (suite / "test_contract.py").write_text(
        "from odoo.tests import tagged\n" + source.replace("class TestContract", declaration + "\nclass TestContract")
    )
    with pytest.raises(ValueError):
        GATE.expected_test_ids(suite)


@pytest.mark.parametrize("rebind", ["import tagged", "import other_package as tagged"])
def test_static_tag_selector_cannot_be_rebound_by_plain_module_import(suite, rebind):
    source = (suite / "test_contract.py").read_text()
    (suite / "test_contract.py").write_text(
        "from odoo.tests import tagged\n" + rebind + "\n" + source.replace(
            "class TestContract", "@tagged('post_install', '-at_install')\nclass TestContract"
        )
    )
    with pytest.raises(ValueError):
        GATE.expected_test_ids(suite)
