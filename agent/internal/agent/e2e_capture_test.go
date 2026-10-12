package agent

import (
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

func validCaptureEnvelope() e2eCaptureEnvelope {
	var e e2eCaptureEnvelope
	e.RunID = "cap_" + hex.EncodeToString(make([]byte, 16))
	e.ClaimToken = hex.EncodeToString(make([]byte, 32))
	e.Simulation = true
	e.Payload.Type = "image"
	e.Payload.Encoding = "base64"
	e.Payload.Data = base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 0xd9})
	e.PaperMM = 80
	return e
}

func TestE2ECaptureNeverAcceptsPrinterOrExecutableBytes(t *testing.T) {
	v := validCaptureEnvelope()
	data, format, err := v.decode()
	if err != nil || format != "jpeg" || len(data) != 4 {
		t.Fatalf("valid capture rejected: %v", err)
	}
	cases := []struct {
		name string
		edit func(*e2eCaptureEnvelope)
	}{
		{"printer field", func(e *e2eCaptureEnvelope) { id := "printer_real"; e.PrinterID = &id }},
		{"missing simulation flag", func(e *e2eCaptureEnvelope) { e.Simulation = false }},
		{"forged run id", func(e *e2eCaptureEnvelope) { e.RunID = "job_123" }},
		{"forged claim", func(e *e2eCaptureEnvelope) { e.ClaimToken = "short" }},
		{"wrong base64", func(e *e2eCaptureEnvelope) { e.Payload.Data = "@@@" }},
		{"raw code", func(e *e2eCaptureEnvelope) { e.Payload.Type = "raw" }},
		{"escpos code", func(e *e2eCaptureEnvelope) { e.Payload.Type = "escpos" }},
		{"paper width", func(e *e2eCaptureEnvelope) { e.PaperMM = 45 }},
		{"pdf override", func(e *e2eCaptureEnvelope) { e.Payload.Type = "pdf" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item := validCaptureEnvelope()
			tc.edit(&item)
			if _, _, err := item.decode(); err == nil {
				t.Fatal("untrusted capture envelope passed admission")
			}
		})
	}
}

func TestE2ECaptureRetentionSkipsUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	unrelated := filepath.Join(dir, "real-print-queue.db")
	if err := os.WriteFile(unrelated, []byte("do not touch"), 0600); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(dir, "capture-old.pdf")
	if err := os.WriteFile(artifact, []byte("outdated"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(artifact, old, old); err != nil {
		t.Fatal(err)
	}
	pruneRemoteCaptures(dir)
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("expired capture should be pruned, got: %v", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated queue file was modified: %v", err)
	}
}

func TestE2ECaptureRequiresExplicitAgentOptIn(t *testing.T) {
	v := &Agent{}
	// Safe default; an unconfigured Agent must never spontaneously poll the
	// Gateway's diagnostic queue on customer installations.
	v.cfg = &config.Config{}
	if v.cfg.Server.E2ECaptureTests {
		t.Fatal("E2E capture must default to off")
	}
}
