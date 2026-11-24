import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("compose_contexts", ROOT / "scripts/check-compose-build-contexts.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_missing_context_is_rejected(tmp_path):
    errors = module.validate_builds({"services": {"caddy": {"build": {"context": str(tmp_path / "missing")}}}})
    assert errors == ["caddy: local build context is missing"]


def test_wrong_dockerfile_context_is_rejected(tmp_path):
    (tmp_path / "Dockerfile").write_text("FROM scratch")
    errors = module.validate_builds({"services": {"caddy": {"build": {"context": str(tmp_path), "dockerfile": "Dockerfile.secure-images"}}}})
    assert errors == ["caddy: Dockerfile is missing from resolved build context"]


def test_resolved_root_and_relative_dockerfile_are_accepted():
    assert module.validate_builds({"services": {"caddy": {"build": {"context": str(ROOT), "dockerfile": "Dockerfile.secure-images"}}}}) == []


def test_inline_dockerfile_and_image_only_service_are_accepted(tmp_path):
    assert module.validate_builds({"services": {
        "image_only": {"image": "local-image"},
        "inline": {"build": {"context": str(tmp_path), "dockerfile_inline": "FROM scratch"}},
    }}) == []
