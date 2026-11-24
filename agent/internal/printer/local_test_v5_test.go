package printer

import (
	"testing"
)

func TestLocalTestNameMustBeUniqueAcrossRegistryAndConfiguration(t *testing.T) {
	registered := []DeviceInfo{{ID: "registry_printer", Name: "Kitchen", Endpoint: "10.0.0.10:9100"}}
	configured := []DeviceInfo{{ID: "configured_printer", Name: "Kitchen", Endpoint: "10.0.0.11:9100"}}
	if target, err := selectLocalTestTarget(registered, configured, "Kitchen"); err == nil || target != nil {
		t.Fatalf("ambiguous local test chose a different physical destination: target=%+v error=%v", target, err)
	}
	if target, err := selectLocalTestTarget(registered, configured, "configured_printer"); err != nil || target == nil || target.ID != "configured_printer" {
		t.Fatalf("explicit stable ID should disambiguate: target=%+v error=%v", target, err)
	}
}

func TestLocalTestNameRejectsDuplicateIDsWithinOneSource(t *testing.T) {
	registered := []DeviceInfo{{ID: "duplicate", Name: "Kitchen", Endpoint: "10.0.0.10:9100"}, {ID: "duplicate", Name: "Kitchen", Endpoint: "10.0.0.11:9100"}}
	if target, err := selectLocalTestTarget(registered, nil, "Kitchen"); err == nil || target != nil {
		t.Fatalf("duplicate registry identities must not become an unambiguous test target: target=%+v error=%v", target, err)
	}
}
