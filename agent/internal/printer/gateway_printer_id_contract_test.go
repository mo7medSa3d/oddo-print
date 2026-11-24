package printer

import (
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// The raw USB/IPP/spooler native proof is consumed by Gateway's
// isExactPrinterId (120 UTF-8 bytes), not by an independent UTF-16 length.
// Invalid IDs must never become trusted geometry or current device evidence.
func TestGeometryAndOperationalProofRequireGatewayExactPrinterID(t *testing.T) {
	cases := []struct {
		name string
		id   string
		want bool
	}{
		{"ASCII exactly 120 bytes", strings.Repeat("p", 120), true},
		{"ASCII over 120 bytes", strings.Repeat("p", 121), false},
		{"Arabic exactly 120 bytes", strings.Repeat("ط", 60), true},
		{"Arabic over 120 bytes", strings.Repeat("ط", 61), false},
		{"emoji exactly 120 bytes", strings.Repeat("🖨", 30), true},
		{"emoji over 120 bytes", strings.Repeat("🖨", 31), false},
		{"leading BOM", "\uFEFFprinter", false},
		{"interior BOM is opaque", "prin\uFEFFter", true},
		{"malformed UTF8", string([]byte{0xed, 0xa0, 0x80}), false},
		{"newline", "printer\nlocal", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pc := config.PrinterConfig{
				ID: tc.id, Name: "Receipt", Type: "spooler",
				Protocol: "spooler", SpoolerName: "Receipt Queue", Endpoint: "Receipt Queue",
			}
			geometry := &Geometry{
				Version: 1, Source: "validated_profile", Validation: "configured",
				ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
				PrinterID:  tc.id, ConfigFingerprint: strings.Repeat("a", 64),
				GeometryProfile: config.GeometryProfile{PrintableWidthDots: 576},
			}
			if valid := geometry.Validate() == nil; valid != tc.want {
				t.Fatalf("geometry proof validity=%t want=%t ID UTF-8 bytes=%d", valid, tc.want, len(tc.id))
			}
			binding, err := config.PrinterBindingDigest(pc)
			if err != nil {
				if tc.want {
					t.Fatalf("valid printer binding rejected: %v", err)
				}
				return
			}
			proof := &OperationalVerification{
				Version: 1, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano),
				PrinterID: tc.id, BindingDigest: binding, LogicalQueueKey: binding,
				Method: "windows_queue", IdentityStrength: "queue", OutputMedium: "physical",
			}
			if valid := proof.Validate(pc, time.Now()) == nil; valid != tc.want {
				t.Fatalf("operational proof validity=%t want=%t ID UTF-8 bytes=%d", valid, tc.want, len(tc.id))
			}
		})
	}
}
