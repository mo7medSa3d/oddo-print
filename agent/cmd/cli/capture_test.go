package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

func TestCaptureRejectsNonregularAndOversizedInput(t *testing.T) {
	dir := t.TempDir()
	if _, err := readBoundedCapture(dir); err == nil {
		t.Fatal("directory accepted as a PDF input")
	}
	missing := filepath.Join(dir, "missing.pdf")
	if _, err := readBoundedCapture(missing); err == nil {
		t.Fatal("missing input accepted")
	}
	huge := filepath.Join(dir, "huge.pdf")
	if err := os.WriteFile(huge, make([]byte, printer.MaxLocalCaptureInput+1), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := readBoundedCapture(huge)
	if err == nil || !strings.Contains(err.Error(), "4 MiB") {
		t.Fatalf("oversized upload was not rejected: %v", err)
	}
}

func TestCaptureCLIRequiresExplicitArguments(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{"-input", "x"},
		{"-input", "x", "-output-dir", "y", "-format", "jpeg", "-paper-mm", "58", "unexpected"},
		{"-bogus"},
	} {
		if err := handleCaptureTest(args); err == nil {
			t.Fatalf("accepted incomplete arguments: %v", args)
		}
	}
}

func TestCapturePruningPreservesUnownedDocuments(t *testing.T) {
	dir := t.TempDir()
	owned := "capture-" + strings.Repeat("a", 24) + ".pdf"
	unowned := "capture-important-invoice.pdf"
	old := time.Now().Add(-72 * time.Hour)
	for _, name := range []string{owned, unowned} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("private document"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	pruneLocalCaptures(dir)
	if _, err := os.Stat(filepath.Join(dir, owned)); !os.IsNotExist(err) {
		t.Fatalf("expired capture artifact was not pruned: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, unowned)); err != nil {
		t.Fatalf("unowned document was deleted during capture pruning: %v", err)
	}
}
