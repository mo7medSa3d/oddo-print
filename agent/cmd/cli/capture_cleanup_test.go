package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestCaptureCleanupDeletesOnlyOldVerifiedEvidence(t *testing.T) {
	root := t.TempDir()
	if err := config.EnsureSecureDirectoryACL(root); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(cfg, []byte("server:\n  url: https://example.test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := config.EnsureSecureFileACL(cfg); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "e2e-captures")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	names := []string{
		"capture-" + strings.Repeat("a", 24) + ".pdf",
		"capture-" + strings.Repeat("b", 24) + ".png",
		"capture-" + strings.Repeat("c", 24) + ".pdf",
		"important.pdf",
		"capture-" + strings.Repeat("d", 24) + ".bin",
		"capture-" + strings.Repeat("E", 24) + ".png",
	}
	for i, name := range names {
		target := filepath.Join(dir, name)
		if err := os.WriteFile(target, []byte("safe-test-data"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := config.EnsureSecureFileACL(target); err != nil {
			t.Fatal(err)
		}
		age := -10 * time.Minute
		if i == 2 {
			age = -15 * time.Second
		}
		if err := os.Chtimes(target, now.Add(age), now.Add(age)); err != nil {
			t.Fatal(err)
		}
	}
	report, err := clearAgentCaptureArtifacts(cfg, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.FilesDeleted != 2 || report.BytesFreed != int64(2*len("safe-test-data")) || report.RecentKept != 1 {
		t.Fatalf("unexpected safe deletion report: %+v", report)
	}
	for i, name := range names {
		_, err := os.Stat(filepath.Join(dir, name))
		if i < 2 && !os.IsNotExist(err) {
			t.Fatalf("eligible capture still exists: %s: %v", name, err)
		}
		if i >= 2 && err != nil {
			t.Fatalf("non-eligible file was removed: %s: %v", name, err)
		}
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Fatal("Agent configuration was removed:", err)
	}
	after, err := clearAgentCaptureArtifacts(cfg, now)
	if err != nil || after.FilesDeleted != 0 {
		t.Fatalf("repeating cleanup must be idempotent, got %+v, %v", after, err)
	}
}

func TestCaptureCleanupRefusesOutsidePathOrNonCaptureFiles(t *testing.T) {
	for _, name := range []string{"capture-abc.pdf", "capture-" + strings.Repeat("a", 24) + ".jpg",
		"capture-" + strings.Repeat("A", 24) + ".pdf", "../capture-" + strings.Repeat("a", 24) + ".pdf",
		"capture-" + strings.Repeat("a", 24) + ".pdf.exe"} {
		if isCaptureOutputName(name) {
			t.Fatalf("accepted unrelated/malicious name: %q", name)
		}
	}
	if _, err := clearAgentCaptureArtifacts(filepath.Join(t.TempDir(), "missing.yaml"), time.Now()); err == nil {
		t.Fatal("must refuse missing protected Agent config")
	}
}
