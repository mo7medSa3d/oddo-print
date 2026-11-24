"""Real POS router method regressions: malformed explicit keys are never 'absent'.

_submit_route already rejects malformed identifiers. Three POS entry paths
previously used a truthiness fallback BEFORE that guard, changing caller
provided 0/[]/{} into a different deterministic key and possibly printing.
"""
import pytest

from test_f010_report_binding_identity import BRANCH, POS_CONFIG, ValidationError, ref
from test_f031_pos_outcome_identity import SimulatedRouter
from test_kitchen_idempotency_fallback import FakeRouter, make_order, route, ValidationError as KitchenValidationError


BAD_KEYS = (0, 2, [], {}, True, "   ")


@pytest.mark.parametrize("method", ["route_pos_receipt", "route_pos_sale_details"])
@pytest.mark.parametrize("operation_key", BAD_KEYS)
def test_receipt_and_sale_details_reject_invalid_explicit_identity_before_submission(method, operation_key):
    router = SimulatedRouter(state="queued")
    submitted = []
    router._submit_route = lambda **kwargs: submitted.append(kwargs) or {"status": "queued"}
    record = ref("pos.order" if method == "route_pos_receipt" else "pos.session", 221,
                 company_id=BRANCH, config_id=POS_CONFIG)
    with pytest.raises(ValidationError, match="operation key"):
        getattr(router, method)(record, "JPEG_DATA_FROM_POS", idempotency_key=operation_key,
                                geometry_fingerprint="a" * 64)
    assert submitted == []


@pytest.mark.parametrize("operation_key", BAD_KEYS)
def test_kitchen_rejects_invalid_explicit_identity_before_submission(operation_key):
    router = FakeRouter()
    # The kitchen AST harness owns its own Odoo ValidationError substitute.
    with pytest.raises(KitchenValidationError, match="operation key"):
        route(router, make_order(), idempotency_key=operation_key)
    assert router.submitted == []


@pytest.mark.parametrize("operation_key", [None, False, ""])
def test_legacy_absent_operation_key_sentinels_preserve_deterministic_fallback(operation_key):
    router = FakeRouter()
    route(router, make_order(), idempotency_key=operation_key)
    first = router.submitted[-1]
    route(router, make_order(), idempotency_key=operation_key)
    assert first == router.submitted[-1]
    assert len(first) == 64
