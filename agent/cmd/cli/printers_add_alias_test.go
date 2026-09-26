package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestPrintersAddAppliesConnectionTypeAliasInBothForms is the regression test
// for a silently-ignored input found in the Phase 4 ignored-result audit.
//
// `_ = fs.String("connection-type", ...)` registered the alias flag, and the
// value was then recovered by scanning the raw argument slice for the exact
// token "--connection-type". Go's flag package also accepts "--flag=value", so
// `printers add --connection-type=spooler` parsed cleanly, was never read, and
// the printer was stored with the --type default instead. The command exited 0
// with no warning, so the operator only discovered it when the printer failed
// to print.
//
// This test builds the real CLI binary and drives it exactly as an operator
// would, comparing the stored connection type reported for both spellings.
func TestPrintersAddAppliesConnectionTypeAliasInBothForms(t *testing.T) {
	tmp := t.TempDir()
	binary := filepath.Join(tmp, "yasser-agent-cli")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}

	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = "."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real CLI binary: %v\n%s", err, out)
	}

	run := func(configPath string, args ...string) string {
		t.Helper()
		full := append([]string{"-config", configPath, "printers", "add"}, args...)
		cmd := exec.Command(binary, full...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("CLI %v failed: %v\n%s", full, err, out)
		}
		return string(out)
	}

	// Both spellings must register the same transport. The space form worked
	// before the fix, so it stays as the control.
	space := run(filepath.Join(tmp, "space.yaml"),
		"--name", "Alias Space", "--connection-type", "spooler",
		"--spooler-name", "QUEUE_SPACE", "--protocol", "spooler", "--id", "alias_space")
	equals := run(filepath.Join(tmp, "equals.yaml"),
		"--name", "Alias Equals", "--connection-type=spooler",
		"--spooler-name", "QUEUE_EQUALS", "--protocol", "spooler", "--id", "alias_equals")

	if !strings.Contains(space, "conn=spooler") {
		t.Errorf("control: --connection-type <value> did not apply: %s", space)
	}
	if !strings.Contains(equals, "conn=spooler") {
		t.Errorf("--connection-type=<value> was silently ignored (the bug): %s", equals)
	}
}
