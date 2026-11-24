package main

import (
	"strings"
	"testing"
)

func TestCLIPrinterDiagnosticCannotClaimPhysicalPrintSuccess(t *testing.T) {
	msg := cliPrinterDiagnosticSuccess("windows-queue")
	for _, want := range []string{"windows-queue", "NOT proof", "test-page", "verify printer output"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("diagnostic message lacks %q: %s", want, msg)
		}
	}
	for _, lie := range []string{"Test print succeeded", "bytes submitted to spooler/TCP"} {
		if strings.Contains(msg, lie) {
			t.Fatalf("diagnostic misrepresents spooler preflight as actual print: %s", msg)
		}
	}
}
