package printer

import (
	"strings"
	"testing"
)

func TestIPPStatusRespectsExplicitReasonSeverity(t *testing.T) {
	for _, tc := range []struct{ name, state, accepting, reasons, want string }{
		{"warning on unused tray", "3", "true", "media-empty-warning", "online"},
		{"processing with warning", "4", "true", "media-jam-warning", "busy"},
		{"report on another device", "3", "true", "offline-report", "online"},
		{"report on another cover", "4", "true", "cover-open-report", "busy"},
		{"stopped stays stopped", "5", "true", "media-empty-warning", "error"},
		{"rejecting stays rejecting", "3", "false", "media-empty-warning", "error"},
		{"warning cannot hide real fault", "3", "true", "toner-empty-warning,door-open-error", "error"},
		{"offline error", "3", "true", "offline-error", "offline"},
		{"vendor error cannot claim ready", "3", "true", "vendor-mechanism-error", "error"},
		{"preserve conservative bare faults", "3", "true", "media-jam", "error"},
		{"legacy pause remains blocked", "3", "true", "paused", "error"},
		{"missing state not invented", "", "true", "media-empty-warning", "unknown"},
		{"whitespace and case", "3", "true", "  MEDIA-EMPTY-WARNING , toner-low-report ", "online"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			attrs := map[string]string{"printer-state-reasons": tc.reasons, "printer-is-accepting-jobs": tc.accepting}
			if tc.state != "" {
				attrs["printer-state"] = tc.state
			}
			got, detail := interpretIPPPrinterStatus(attrs)
			if got != tc.want {
				t.Fatalf("reasons=%q state=%q: got %s, want %s", tc.reasons, tc.state, got, tc.want)
			}
			if detail != strings.ToLower(tc.reasons) {
				t.Fatalf("original diagnostic evidence was lost: %q", detail)
			}
		})
	}
}
