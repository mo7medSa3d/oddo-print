from pathlib import Path


def test_first_run_uses_runtime_entrypoints_not_removed_global_npm():
    root = Path(__file__).resolve().parents[1]
    guide = (root / 'SERVER_FIRST_RUN.md').read_text()
    runtime = (root / 'Dockerfile').read_text()
    assert '/usr/local/bin/npm' in runtime and 'rm -rf' in runtime
    assert 'gateway npm run' not in guide
    assert 'gateway node --import tsx scripts/provision-plans.ts' in guide
    assert 'gateway node --import tsx scripts/bootstrap-platform-owner.ts' in guide
