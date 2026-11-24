package printer

import (
	"fmt"
	"strings"
	"testing"
)

func TestPWGExplicitUnavailableCapabilitiesNeverSelectDefaults(t *testing.T) {
	for _, name := range []string{"pwg-raster-document-resolution-supported", "pwg-raster-document-type-supported"} {
		for _, tag := range []byte{0x10, 0x12, 0x13} {
			t.Run(fmt.Sprintf("%s/tag_%02x", name, tag), func(t *testing.T) {
				r := ippPrinterAttributesFixture()
				r.attrs = append(r.attrs, ippEvidenceTestAttribute{4, tag, name, nil})
				attrs, err := parseIPPPrinterAttributes(r.bytes(), 1)
				if err != nil {
					t.Fatalf("valid unavailable Printer attribute rejected: %v", err)
				}
				if value, present := attrs[name]; !present || value != "" {
					t.Fatalf("explicit unavailable value was confused with omission: %v", attrs)
				}
				// Keep the other required capability valid to isolate this case.
				if name == "pwg-raster-document-type-supported" {
					attrs["pwg-raster-document-resolution-supported"] = "300x300dpi"
				} else {
					attrs["pwg-raster-document-type-supported"] = "sgray_8"
				}
				if _, _, err := pwgOptionsFromIPPAttributes(attrs); err == nil || !strings.Contains(err.Error(), name) {
					t.Fatalf("unknown capability authorized unadvertised raster defaults: %v", err)
				}
			})
		}
		for _, empty := range []string{"", " "} {
			if _, _, err := pwgOptionsFromIPPAttributes(map[string]string{name: empty}); err == nil {
				t.Fatalf("explicit empty %s authorized raster defaults", name)
			}
		}
	}
}
