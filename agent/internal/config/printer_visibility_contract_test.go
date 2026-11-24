package config

import (
	"path/filepath"
	"testing"
)

// WP3: an unrelated deny must not privatise a locally registered spooler
// printer, while a cloud-only destination still stays private until it is
// explicitly registered locally. The share/unshare round-trip keeps the
// same stable identity (ID + binding) in both directions.
func TestUnrelatedDenyDoesNotPrivatiseRegisteredSpooler(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	denied := sharingTestQueue("denied", "Private POS80")
	registered := sharingTestQueue("registered", "Receipt queue")
	registered.Capabilities = map[string]interface{}{"registration_source": "registry", "verification": "verified"}
	manual := sharingTestQueue("manual", "Manual queue")
	manual.Capabilities = map[string]interface{}{"registration_source": "manual"}
	cloudOnly := sharingTestQueue("cloud-only", `\\host.example.test\NativeShare`)
	candidate := sharingTestQueue("candidate", "Candidate queue")
	candidate.Capabilities = map[string]interface{}{"registration_source": "registry", "verification": "candidate_only"}

	if err := SetPrinterVisibility(path, denied, nil, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterVisibility(path)
	if err != nil {
		t.Fatal(err)
	}
	// Registered via the known list (the pre-existing path).
	if shared, err := policy.Shared(registered, []PrinterConfig{denied, registered}); err != nil || !shared {
		t.Fatalf("registered spooler privatised by unrelated deny: shared=%v err=%v", shared, err)
	}
	// Registered via its own explicit local marker, even when the
	// caller's known list is stale/incomplete (the WP3 trap fix).
	if shared, err := policy.Shared(registered, []PrinterConfig{denied}); err != nil || !shared {
		t.Fatalf("registry-marked spooler privatised by stale known list: shared=%v err=%v", shared, err)
	}
	if shared, err := policy.Shared(manual, []PrinterConfig{denied}); err != nil || !shared {
		t.Fatalf("manually registered spooler privatised by unrelated deny: shared=%v err=%v", shared, err)
	}
	// Cloud-only: no local registration, not in the known list — still
	// private while any deny exists. This is the privacy gate, unchanged.
	if shared, err := policy.Shared(cloudOnly, []PrinterConfig{denied}); err != nil || shared {
		t.Fatalf("cloud-only destination self-authorized under an unrelated deny: shared=%v err=%v", shared, err)
	}
	// Setup-only registry candidate: still private.
	if shared, err := policy.Shared(candidate, []PrinterConfig{denied, candidate}); err != nil || shared {
		t.Fatalf("setup-only candidate authorized by an unrelated deny: shared=%v err=%v", shared, err)
	}
	// The denied printer itself stays denied.
	if shared, err := policy.Shared(denied, []PrinterConfig{denied}); err != nil || shared {
		t.Fatalf("denied printer became shared: shared=%v err=%v", shared, err)
	}
}

func TestSharingRoundTripKeepsStableIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	pc := sharingTestQueue("receipt", "Receipt queue")
	pc.Capabilities = map[string]interface{}{"registration_source": "registry", "verification": "verified"}
	other := sharingTestQueue("other", "Other queue")
	other.Capabilities = map[string]interface{}{"registration_source": "registry", "verification": "verified"}

	// Share path: with an unrelated deny present, the registered printer
	// is visible (shared) with the same ID it was registered under.
	unrelated := sharingTestQueue("unrelated", "Private POS80")
	if err := SetPrinterVisibility(path, unrelated, []PrinterConfig{unrelated}, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterVisibility(path)
	if err != nil {
		t.Fatal(err)
	}
	known := []PrinterConfig{unrelated, other, pc}
	if shared, err := policy.Shared(pc, known); err != nil || !shared {
		t.Fatalf("shared printer not visible under unrelated deny: %v %v", shared, err)
	}
	if shared, err := policy.Shared(other, known); err != nil || !shared {
		t.Fatalf("second registered printer not visible under unrelated deny: %v %v", shared, err)
	}

	// Unshare path: the same printer, same binding, is removed/disabled
	// (reported private) by an explicit unshare, and only by that.
	if err := SetPrinterVisibility(path, pc, known, false); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterVisibility(path)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(pc, known); err != nil || shared {
		t.Fatalf("explicitly unshared printer still visible: %v %v", shared, err)
	}
	// And the other registered printer is untouched by this unshare.
	if shared, err := policy.Shared(other, known); err != nil || !shared {
		t.Fatalf("other printer flipped by another printer's unshare: %v %v", shared, err)
	}

	// Re-share restores visibility with the same identity.
	if err := SetPrinterVisibility(path, pc, known, true); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterVisibility(path)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(pc, known); err != nil || !shared {
		t.Fatalf("reshared printer not visible again: %v %v", shared, err)
	}
	if _, denied := policy.DeniedPrinters[pc.ID]; denied {
		t.Fatal("reshare left a stale deny for the same ID")
	}
}
