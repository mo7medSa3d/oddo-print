"""Native Git fixtures for the Windows release change classifier."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = next(step["run"] for step in yaml.safe_load(
    (ROOT / ".github/workflows/build-windows.yml").read_text(encoding="utf-8")
)["jobs"]["changes"]["steps"] if step.get("id") == "filter")


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class WindowsChangedPaths(unittest.TestCase):
    def assert_windows_build(self, first_path, *, rename=None):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-q")
            git(repo, "config", "user.email", "fixture@example.invalid")
            git(repo, "config", "user.name", "fixture")
            old = repo / first_path
            old.parent.mkdir(parents=True, exist_ok=True)
            old.write_text("native content\n")
            git(repo, "add", ".")
            git(repo, "commit", "-qm", "baseline")
            base = git(repo, "rev-parse", "HEAD")
            if rename:
                target = repo / rename
                target.parent.mkdir(parents=True, exist_ok=True)
                git(repo, "mv", first_path, rename)
            else:
                old.write_text("updated native content\n")
            git(repo, "add", ".")
            git(repo, "commit", "-qm", "change")
            head = git(repo, "rev-parse", "HEAD")
            output = repo / "gha-output"
            env = os.environ | {"BASH_ENV": "", "GITHUB_EVENT_NAME": "push", "EVENT_NAME": "push", "BEFORE_SHA": base,
                                "GITHUB_SHA": head, "GITHUB_OUTPUT": str(output)}
            cp = subprocess.run(["bash", "-e", "-c", SCRIPT], cwd=repo, env=env,
                                capture_output=True, text=True, timeout=15)
            self.assertEqual(cp.returncode, 0, cp.stderr + "\n" + cp.stdout)
            self.assertIn("windows=true", output.read_text(), (cp.stdout, output.read_text()))

    def test_rename_from_native_source_to_docs_remains_native_change(self):
        self.assert_windows_build("src-tauri/native.rs", rename="docs/native.md")

    def test_native_filename_containing_newline_does_not_evade_windows_build(self):
        self.assert_windows_build("src-tauri/native\nweird.rs")

    def test_shared_typography_source_triggers_windows_build(self):
        self.assert_windows_build("typography/tokens.css")


if __name__ == "__main__":
    unittest.main()
