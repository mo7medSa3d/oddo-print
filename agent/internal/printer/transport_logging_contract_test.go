package printer

import (
	"os"
	"strings"
	"testing"
)

// A successful USB/Windows spooler API return proves transfer admission, not
// that sheets physically emerged. Operator diagnostic logs must say so.
func TestNativeTransportLogsNeverAssertPhysicalPaperFromSubmission(t *testing.T) {
	for _, tc := range []struct {
		file       string
		misleading string
	}{
		{file: "usb_windows.go", misleading: "Direct USB printed"},
		{file: "spooler_windows.go", misleading: "Spooler printed"},
	} {
		t.Run(tc.file, func(t *testing.T) {
			raw, err := os.ReadFile(tc.file)
			if err != nil {
				t.Fatal(err)
			}
			source := string(raw)
			if strings.Contains(source, tc.misleading) {
				t.Fatalf("transport completion cannot claim paper output: %s", tc.misleading)
			}
			if !strings.Contains(source, "physical output unconfirmed") {
				t.Fatalf("%s must explicitly describe uncertain physical output", tc.file)
			}
		})
	}
}
