from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel: str) -> str:
    return (ADDON / rel).read_text(encoding="utf-8")


def test_runtime_pickers_abort_and_do_not_block_first_paint():
    for rel in (
        "static/src/components/runtime_agent_field.js",
        "static/src/components/runtime_printer_field.js",
    ):
        source = read(rel)
        assert "startRpcWithDeadline" in source
        assert "onWillUnmount" in source
        assert "activeRequest?.cancel()" in source
        assert "onWillStart" not in source


def test_language_switcher_has_finite_nonblocking_requests():
    source = read("static/src/components/language_switcher.js")
    assert "onMounted(() => this.loadLanguages())" in source
    assert "withGatewayDeadline" in source
    assert "onWillStart" not in source
    assert "onWillUnmount" in source


def test_rpc_deadline_owns_real_xhr_and_aborts_it():
    source = read("static/src/js/async_control.js")
    assert "new XMLHttpRequest()" in source
    assert "rpcFn(route, params, { xhr, silent })" in source
    assert "xhr.abort()" in source
    assert "GatewayTimeoutError" in source


def test_pos_gateway_operations_are_bounded_and_submission_timeout_is_ambiguous():
    source = read("static/src/js/pos_print_router.js")
    assert "gatewayDataCall" in source
    assert "gatewayRender" in source
    assert "gatewaySync" in source
    assert "gatewaySilentCall" in source
    assert "this.data.call(" not in source
    assert "this.data.silentCall(" not in source
    assert "this.syncAllOrders(" not in source
    assert source.count("{ ambiguous: true }") >= 2
    assert "retry will reuse the same operation to prevent a duplicate" in source
