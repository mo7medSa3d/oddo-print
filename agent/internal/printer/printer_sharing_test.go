package printer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func sharingDevice(id, queue string) DeviceInfo {
	return DeviceInfo{ID: id, Name: queue, ConnectionType: "spooler", Protocol: "spooler", SpoolerName: queue, Endpoint: queue, Enabled: true, Status: "offline", PrinterType: "thermal"}
}

func TestSharingSelectionRejectsCandidatesVirtualAndAmbiguousIDs(t *testing.T) {
	good := sharingDevice("local", "POS80 Printer")
	selected, err := SelectSharingPrinter("local", []DeviceInfo{good})
	if err != nil || selected.SpoolerName != good.SpoolerName {
		t.Fatalf("offline physical queue selection: %+v %v", selected, err)
	}
	for _, device := range []DeviceInfo{
		{ID: "local", Name: "Microsoft Print to PDF", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "Microsoft Print to PDF", IsVirtual: true},
		{ID: "local", Name: "POS80", ConnectionType: "spooler", Protocol: "spooler", SpoolerName: "POS80", Capabilities: map[string]interface{}{"verification": "candidate_only", "registration_source": "manual"}},
		{ID: "local", Name: "USB printer", ConnectionType: "usb", Protocol: "raw", USBVID: "1234", USBPID: "5678"},
	} {
		if _, err := SelectSharingPrinter("local", []DeviceInfo{device}); err == nil {
			t.Fatalf("unproven/virtual selection accepted: %+v", device)
		}
	}
	if _, err := SelectSharingPrinter("local", []DeviceInfo{good, good}); err == nil {
		t.Fatal("ambiguous ID accepted")
	}
	if _, err := SelectSharingPrinter("missing", []DeviceInfo{good}); err == nil {
		t.Fatal("missing ID accepted")
	}
}

func TestLocalSharingAnnotationKeepsPrivateStatusAndRegistryIndependent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	registry := config.RegistryPath(path)
	device := sharingDevice("local", "POS80 Printer")
	data, err := json.Marshal([]DeviceInfo{device})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registry, data, 0600); err != nil {
		t.Fatal(err)
	}
	pc := SharingConfigForDevice(device)
	if err := config.SetPrinterSharing(path, pc, []config.PrinterConfig{pc}, false); err != nil {
		t.Fatal(err)
	}
	rows, err := AnnotatePrinterSharing(path, &config.Config{}, registry, []DeviceInfo{device})
	if err != nil || len(rows) != 1 {
		t.Fatalf("local private inventory omitted: %+v %v", rows, err)
	}
	if rows[0].SharedWithGateway == nil || *rows[0].SharedWithGateway || rows[0].Status != "offline" || !rows[0].Enabled {
		t.Fatalf("local sharing changed health/Enabled: %+v", rows[0])
	}
	if device.SharedWithGateway != nil {
		t.Fatal("annotation mutated caller DTO")
	}
	after, err := os.ReadFile(registry)
	if err != nil || string(after) != string(data) {
		t.Fatalf("annotation rewrote registry: %v", err)
	}
	encoded, err := json.Marshal(rows)
	if err != nil || !strings.Contains(string(encoded), `"sharedWithGateway":false`) {
		t.Fatalf("explicit false lost: %s %v", encoded, err)
	}
	if err := config.SetPrinterSharing(path, pc, []config.PrinterConfig{pc}, true); err != nil {
		t.Fatal(err)
	}
	rows, err = AnnotatePrinterSharing(path, &config.Config{}, registry, []DeviceInfo{device})
	if err != nil || rows[0].SharedWithGateway == nil || !*rows[0].SharedWithGateway {
		t.Fatalf("fresh durable reshare not observed: %+v %v", rows, err)
	}
}

func TestSharingAnnotationEmptyArrayAndCorruptPolicyError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	rows, err := AnnotatePrinterSharing(path, nil, config.RegistryPath(path), nil)
	encoded, encodeErr := json.Marshal(rows)
	if err != nil || encodeErr != nil || string(encoded) != "[]" {
		t.Fatalf("empty CLI inventory must be []: %s %v %v", encoded, err, encodeErr)
	}
	if err := os.WriteFile(config.PrinterSharingPath(path), []byte(`{"version":1,"deniedPrinters":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := AnnotatePrinterSharing(path, nil, config.RegistryPath(path), []DeviceInfo{sharingDevice("local", "POS80")}); err == nil {
		t.Fatal("corrupt policy silently exposed shared inventory")
	}
}

func TestSharingAnnotationInvalidCurrentDeniedBindingReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	device := sharingDevice("local", "POS80 Printer")
	pc := SharingConfigForDevice(device)
	if err := config.SetPrinterSharing(path, pc, nil, false); err != nil {
		t.Fatal(err)
	}
	broken := pc
	broken.SpoolerName, broken.Endpoint = "", ""
	if _, err := AnnotatePrinterSharing(path, &config.Config{Printers: []config.PrinterConfig{broken}}, config.RegistryPath(path), []DeviceInfo{device}); err == nil {
		t.Fatal("invalid current denied binding exposed local DTO as known shared authority")
	}
}

func TestVerifiedNativeShareAliasesPersistAcrossRegistryLossAndRemainQueueScoped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	device := sharingDevice("stable", "POS80 Printer")
	device.SpoolerServer, device.SpoolerShare = "", "NativeShare"
	device.Capabilities = map[string]interface{}{"discovered_via": SourceSpooler, "spooler_attributes": uint32(0x8)}
	bindings, err := SharingBindingsForDevice(device)
	if err != nil || len(bindings) != 2 || !bindings[1].VerifiedSpoolerSharingAlias {
		t.Fatalf("verified native share relation lost: %+v %v", bindings, err)
	}
	if err := config.SetPrinterSharing(path, bindings[0], bindings, false); err != nil {
		t.Fatal(err)
	}
	policy, err := config.LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(policy.DeniedPrinterAliases[device.ID]) != 1 {
		t.Fatalf("verified alias not persisted independently: %+v", policy)
	}
	// Fresh registry/native details may vanish, but its already verified
	// alias remains private with a new desired/cloud ID and loopback server.
	alias := bindings[1]
	alias.ID, alias.SpoolerName = "cloud-id", `\\localhost\NativeShare`
	alias.Endpoint = alias.SpoolerName
	if shared, err := policy.Shared(alias, nil); err != nil || shared {
		t.Fatalf("stored native alias bypassed after detail loss: %v %v", shared, err)
	}
	if policy.DiscoveryShared(alias, nil) {
		t.Fatal("stored alias leaked remote discovery metadata")
	}
	other := SharingConfigForDevice(sharingDevice("other", "Different POS80 Queue"))
	other.USBSerial = device.USBSerial
	if shared, err := policy.Shared(other, []config.PrinterConfig{other}); err != nil || !shared {
		t.Fatalf("unrelated independently known named queue merged: %v %v", shared, err)
	}
	// A changed discovery ID/current share must inherit the old exact native
	// queue deny, while never treating another queue's friendly label as proof.
	current := device
	current.ID, current.SpoolerShare = "rediscovered-id", "NewNativeShare"
	currentBindings, err := SharingBindingsForDevice(current)
	if err != nil {
		t.Fatal(err)
	}
	currentAlias := currentBindings[1]
	currentAlias.ID = "new-desired-id"
	if shared, err := policy.Shared(currentAlias, currentBindings); err != nil || shared {
		t.Fatalf("new ID/current verified alias bypassed exact queue binding: %v %v", shared, err)
	}
	// The original verified share also identifies the fresh descriptor group
	// when BOTH the stable discovery ID and native primary queue name change.
	renamed := device
	renamed.ID, renamed.Name, renamed.SpoolerName, renamed.Endpoint = "new-native-id", "New queue", "Renamed POS80", "Renamed POS80"
	renamedBindings, err := SharingBindingsForDevice(renamed)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(renamedBindings[0], renamedBindings); err != nil || shared {
		t.Fatalf("same verified share did not protect changed ID/primary: %v %v", shared, err)
	}
	if policy.DiscoveryShared(renamedBindings[0], renamedBindings) {
		t.Fatal("changed primary exposed through same verified native share")
	}
	before, err := os.ReadFile(config.PrinterSharingPath(path))
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SetPrinterSharing(path, alias, nil, true); err == nil {
		t.Fatal("historical alias alone erased a different stable queue's denial")
	}
	after, err := os.ReadFile(config.PrinterSharingPath(path))
	if err != nil || string(before) != string(after) {
		t.Fatalf("ambiguous reshare changed protected denials: %v", err)
	}
	if err := config.SetPrinterSharing(path, bindings[0], nil, true); err != nil {
		t.Fatal(err)
	}
	policy, err = config.LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(policy.DeniedPrinterAliases) != 0 || len(policy.DeniedPrinters) != 0 {
		t.Fatalf("selected stable queue reshare kept its anchored aliases: %+v", policy)
	}
	if shared, err := policy.Shared(alias, nil); err != nil || !shared {
		t.Fatalf("explicit stable queue reshare did not permit its alias: %v %v", shared, err)
	}
}

func TestNativeShareAliasesRequireFirstClassInfo2SharedEvidence(t *testing.T) {
	base := sharingDevice("stable", "POS80 Printer")
	base.SpoolerServer, base.SpoolerShare = `\\PrintServer`, "NativeShare"
	for _, caps := range []map[string]interface{}{
		{"discovered_via": SourceSpooler, "spooler_attributes": uint32(0)},
		{"registration_source": "manual", "spooler_attributes": uint32(0x8)},
		{"discovered_via": SourceSpooler, "spooler_attributes": 8.5},
	} {
		base.Capabilities = caps
		bindings, err := SharingBindingsForDevice(base)
		if err != nil || len(bindings) != 1 {
			t.Fatalf("unverified native relation accepted: %+v %v", bindings, err)
		}
	}
	base.SpoolerShare = ""
	base.Capabilities = map[string]interface{}{"discovered_via": SourceSpooler, "spooler_attributes": float64(8), "server_name": `\\PrintServer`, "share_name": "TaintedCapabilityShare"}
	if bindings, err := SharingBindingsForDevice(base); err != nil || len(bindings) != 1 {
		t.Fatalf("capability-only share manufactured identity: %+v %v", bindings, err)
	}
	base.SpoolerShare = "NativeShare"
	bindings, err := SharingBindingsForDevice(base)
	if err != nil || len(bindings) != 2 || bindings[1].SpoolerName != `\\PrintServer\NativeShare` {
		t.Fatalf("persisted native numeric attributes failed: %+v %v", bindings, err)
	}
}

func TestSharingAnnotationFreshNativeGroupsProtectAliasesBeforeRegistryPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	private := sharingDevice("stable", "Private POS80")
	private.SpoolerShare = "NativeShare"
	private.Capabilities = map[string]interface{}{"discovered_via": SourceSpooler, "spooler_attributes": uint32(8)}
	bindings, err := SharingBindingsForDevice(private)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SetPrinterSharing(path, bindings[0], bindings, false); err != nil {
		t.Fatal(err)
	}
	renamed := private
	renamed.ID, renamed.Name, renamed.SpoolerName, renamed.Endpoint = "new-id", "Renamed private", "Renamed POS80", "Renamed POS80"
	separate := sharingDevice("new-unrelated", "Independent local POS80")
	separate.Capabilities = map[string]interface{}{"discovered_via": SourceSpooler}
	candidate := sharingDevice("candidate", "Unverified session queue")
	candidate.Capabilities = map[string]interface{}{"verification": "candidate_only"}
	rows, err := AnnotatePrinterSharing(path, nil, config.RegistryPath(path), []DeviceInfo{renamed, separate, candidate})
	if err != nil || len(rows) != 3 {
		t.Fatalf("fresh local annotation: %+v %v", rows, err)
	}
	for i, want := range []bool{false, true, false} {
		if rows[i].SharedWithGateway == nil || *rows[i].SharedWithGateway != want || rows[i].Status != "offline" {
			t.Fatalf("fresh local group/candidate/health row%d: %+v", i, rows[i])
		}
	}
	if _, err := os.Stat(config.RegistryPath(path)); !os.IsNotExist(err) {
		t.Fatalf("read-only projection persisted registry: %v", err)
	}
	renamed.SpoolerShare = `bad\share`
	if _, err := AnnotatePrinterSharing(path, nil, config.RegistryPath(path), []DeviceInfo{separate, renamed}); err == nil {
		t.Fatal("malformed fresh native relation exposed partial local projection")
	}
}
