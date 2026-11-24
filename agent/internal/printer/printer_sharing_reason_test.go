package printer

import (
	"strings"
	"testing"
)

// WP3: a sharing refusal must say WHY the row is not a candidate, instead
// of a single opaque sentence. The decision is unchanged: only a locally
// admitted physical execution destination is selectable.
func TestSharingCandidateReasonSurfacesPerRowCause(t *testing.T) {
	good := sharingDevice("local", "POS80 Printer")
	if reason := SharingCandidateReason(good); reason != "" {
		t.Fatalf("admitted offline queue got a refusal reason: %q", reason)
	}
	if _, err := SelectSharingPrinter("local", []DeviceInfo{good}); err != nil {
		t.Fatalf("admitted queue refused: %v", err)
	}
	cases := []struct {
		name   string
		device DeviceInfo
		want   string
	}{
		{
			name:   "virtual software queue",
			device: DeviceInfo{ID: "local", Name: "Microsoft Print to PDF", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Microsoft Print to PDF", IsVirtual: true},
			want:   "virtual",
		},
		{
			name:   "redirected session queue",
			device: DeviceInfo{ID: "local", Name: "Redirected Printer", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Redirected Printer", PrinterType: "redirected"},
			want:   "redirected",
		},
		{
			name:   "per-user candidate with a recorded cause",
			device: DeviceInfo{ID: "local", Name: "POS80", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "POS80", Capabilities: map[string]interface{}{"verification": "candidate_only", "candidate_reason": "per_user_spooler_connection"}},
			want:   "per_user_spooler_connection",
		},
		{
			name:   "candidate without a recorded cause still explains itself",
			device: DeviceInfo{ID: "local", Name: "POS80", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "POS80", Capabilities: map[string]interface{}{"verification": "candidate_only"}},
			want:   "setup-only candidate",
		},
		{
			name:   "device-detected-only candidate",
			device: DeviceInfo{ID: "local", Name: "POS80", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "POS80", Capabilities: map[string]interface{}{"verification": "device_detected_only"}},
			want:   "device detected",
		},
		{
			name: "row outside the runtime inventory",
			device: func() DeviceInfo {
				d := sharingDevice("local", "POS80 Printer")
				d.Capabilities = map[string]interface{}{"inventory_present": false}
				return d
			}(),
			want: "runtime inventory",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := SharingCandidateReason(tc.device)
			if reason == "" || !strings.Contains(reason, tc.want) {
				t.Fatalf("reason=%q, want it to contain %q", reason, tc.want)
			}
			if _, err := SelectSharingPrinter("local", []DeviceInfo{tc.device}); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("selection error did not carry the reason: %v", err)
			}
		})
	}
	if _, err := SelectSharingPrinter("local", []DeviceInfo{good, good}); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous ID lost its reason: %v", err)
	}
	if _, err := SelectSharingPrinter("missing", []DeviceInfo{good}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing ID lost its reason: %v", err)
	}
}

func TestSharingCandidateReasonWithAllowVirtualStillBlocksUnusableAndOutOfInventory(t *testing.T) {
	pdf := DeviceInfo{
		ID: "virt-pdf", Name: "Microsoft Print to PDF",
		ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "Microsoft Print to PDF", SpoolerPort: "PORTPROMPT:",
		IsVirtual: true,
	}
	if reason := SharingCandidateReasonWithOptions(pdf, true); reason != "" {
		t.Fatalf("printable virtual queue refused with allowVirtual=true: %q", reason)
	}
	fax := DeviceInfo{
		ID: "virt-fax", Name: "Fax",
		ConnectionType: "spooler", Protocol: "spooler",
		SpoolerName: "Fax", SpoolerPort: "SHRFAX:",
		IsVirtual: true,
	}
	if reason := SharingCandidateReasonWithOptions(fax, true); reason == "" || !strings.Contains(reason, "unusable") {
		t.Fatalf("fax queue must stay refused with allowVirtual=true, got %q", reason)
	}
	outOfInv := sharingDevice("hidden", "POS80 Printer")
	outOfInv.Capabilities = map[string]interface{}{"inventory_present": false}
	if reason := SharingCandidateReasonWithOptions(outOfInv, true); reason == "" || !strings.Contains(reason, "runtime inventory") {
		t.Fatalf("out-of-inventory queue must stay refused with allowVirtual=true, got %q", reason)
	}
}
