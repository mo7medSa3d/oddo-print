package printer

import (
	"strings"
	"testing"
)

// The Gateway's isExactPrinterId wire contract accepts at most 120 UTF-8
// bytes. Geometry and operational evidence must never authorize a printer
// that the Gateway will reject or alias during JSON/UTF-8 conversion.
func TestPrinterEvidenceIdentityMatchesGatewayUTF8Boundary(t *testing.T) {
	cases := []struct {
		name   string
		id     string
		accept bool
	}{
		{"ascii", "printer_frontdesk", true},
		{"arabic", "طابعة_المطبخ", true},
		{"multibyte_at_limit", strings.Repeat("é", 60), true},
		{"multibyte_over_limit", strings.Repeat("é", 61), false},
		{"four_byte_at_limit", strings.Repeat("🖨", 30), true},
		{"four_byte_over_limit", strings.Repeat("🖨", 31), false},
		{"leading_bom", "\uFEFFprinter", false},
		{"trailing_bom", "printer\uFEFF", false},
		{"invalid_utf8", "printer\xff", false},
		{"control_character", "printer\u0085", false},
		{"surrounding_whitespace", " printer", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validGeometryPrinterID(tc.id); got != tc.accept {
				t.Fatalf("printer ID must match Gateway's exact UTF-8 evidence identity: bytes=%d accepted=%v want=%v", len(tc.id), got, tc.accept)
			}
		})
	}
}
