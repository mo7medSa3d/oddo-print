"""Offline deployment and translation contract regressions for the repair."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def test_docker_runtime_contains_server_payload_contract():
    source = (ROOT / "Dockerfile").read_text()
    runtime = source[source.index(" AS runtime\n"):]
    assert "COPY --from=build /app/contracts ./contracts" in runtime
    assert "USER node" in runtime

def test_translation_checker_rejects_lost_duplicate_placeholders(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("translation_check", ROOT / "scripts/check-odoo-translations.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    catalog = tmp_path / "ar.po"
    catalog.write_text('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: ar\\n"\n"Plural-Forms: nplurals=6; plural=0;\\n"\n\nmsgid "%s then %s"\nmsgstr "%s ثم"\n')
    monkeypatch.setattr(module, "ADDON", tmp_path)
    monkeypatch.setattr(module, "CATALOG", catalog)
    monkeypatch.setattr(module, "extract_terms", lambda: {"%s then %s": "source.js"})
    assert module.main() == 1
    catalog.write_text(catalog.read_text().replace('msgstr "%s ثم"', 'msgstr "%s ثم %s"'))
    assert module.main() == 0
