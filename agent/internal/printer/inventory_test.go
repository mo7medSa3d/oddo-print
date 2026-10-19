package printer

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func inventoryTestDevice(id, connection, protocol, endpoint, source, discoveredVia string) DeviceInfo {
	device := DeviceInfo{
		ID: id, Name: "Named " + id, ConnectionType: connection, Protocol: protocol,
		Endpoint: endpoint, Enabled: true,
		Capabilities: map[string]interface{}{"registration_source": source, "discovered_via": discoveredVia},
	}
	if connection == "spooler" {
		device.SpoolerName = endpoint
	}
	return device
}

func TestWindowsMainInventoryKeepsInstalledAndSelectedPrinters(t *testing.T) {
	queue := inventoryTestDevice("queue", "spooler", "spooler", "Canon G4070", "discovery", SourceSpooler)
	scanRAW := inventoryTestDevice("scan-raw", "network", "raw", "10.0.0.20:9100", "discovery", SourceSNMP)
	scanIPP := inventoryTestDevice("scan-ipp", "ipp", "ipp", "ipp://10.0.0.20/ipp/print", "discovery", SourceIPP)
	scanIPP.Capabilities["ipp_verified"] = true
	scanUSB := inventoryTestDevice("scan-usb", "usb", "raw", `\\?\usb#printer`, "discovery", SourceUSB)
	manual := inventoryTestDevice("selected-direct", "network", "escpos", "10.0.0.20:9100", "manual", SourceSNMP)
	configured := inventoryTestDevice("configured-ipp", "ipp", "ipp", "ipp://10.0.0.21/ipp/print", "config", SourceIPP)
	configured.Capabilities["ipp_verified"] = true
	legacy := inventoryTestDevice("legacy", "network", "raw", "10.0.0.22:9100", "registry", "")
	input := []DeviceInfo{queue, scanRAW, scanIPP, scanUSB, manual, configured, legacy}
	got := runtimeInventoryPrintersForPlatform(input, "windows")
	var ids []string
	for _, device := range got {
		ids = append(ids, device.ID)
	}
	if !reflect.DeepEqual(ids, []string{"queue", "selected-direct", "configured-ipp", "legacy"}) {
		t.Fatalf("setup candidates leaked into main inventory or selected transports disappeared: %v", ids)
	}
	if len(input) != 7 || input[1].Capabilities["registration_source"] != "discovery" {
		t.Fatal("admission mutated the caller's setup observations")
	}
	if !IsRuntimeDiscoveryPrinter(scanRAW) || !IsRuntimeDiscoveryPrinter(scanIPP) {
		t.Fatal("main-fleet policy must not remove a verified candidate's execution/provisioning capability")
	}
	if got := runtimeInventoryPrintersForPlatform(input, "linux"); len(got) != len(input) {
		t.Fatalf("Windows inventory policy changed non-Windows transports: %#v", got)
	}
}

func TestWindowsMainInventoryKeepsRegistryFallbackAsSetupEvidence(t *testing.T) {
	device := inventoryTestDevice("registry-only", "spooler", "spooler", "Old Queue", "discovery", SourceSpooler)
	device.Capabilities["verification"] = "candidate_only"
	device.Capabilities["candidate_reason"] = "registry_queue_unverified"
	if got := runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows"); len(got) != 0 {
		t.Fatalf("a persisted Windows registry name was mistaken for a current installed queue: %#v", got)
	}
	for _, source := range []string{"manual", "config"} {
		device.Capabilities["registration_source"] = source
		if got := runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows"); len(got) != 1 {
			t.Fatalf("explicit %s intent was hidden by an inherited discovery-only marker", source)
		}
	}
}

func TestSelectedDiscoveryEvidenceStillValidatesItsTransport(t *testing.T) {
	device := inventoryTestDevice("selected-ipp", "ipp", "ipp", "ipp://10.0.0.20/ipp/print", "manual", SourceIPP)
	device.Capabilities["ipp_verified"] = false
	device.Capabilities["verification"] = "candidate_only"
	if !IsRuntimeDiscoveryPrinter(device) {
		t.Fatal("a selected IPP transport still required an automatic discovery proof marker")
	}
	device.Endpoint = "ipp://127.0.0.1/ipp/print"
	if IsRuntimeDiscoveryPrinter(device) {
		t.Fatal("manual selection bypassed endpoint safety")
	}
	device = inventoryTestDevice("selected-lpr", "network", "lpr", "10.0.0.20:515", "manual", SourceLPR)
	if IsRuntimeDiscoveryPrinter(device) {
		t.Fatal("manual selection invented an unsupported LPR execution backend")
	}
	device = inventoryTestDevice("pdf-writer", "spooler", "spooler", "Microsoft Print to PDF", "manual", SourceSpooler)
	if IsRuntimeDiscoveryPrinter(device) {
		t.Fatal("manual selection admitted a software printer")
	}
}

func TestWindowsUnnamedAutomaticQueueIsNotAdmitted(t *testing.T) {
	device := inventoryTestDevice("unnamed", "spooler", "spooler", "Queue", "discovery", SourceSpooler)
	device.SpoolerName = " "
	if got := runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows"); len(got) != 0 {
		t.Fatalf("automatic queue without a native queue name entered inventory: %#v", got)
	}
}

func TestLegacyStructuredDiscoveryOriginCannotBypassMainPolicy(t *testing.T) {
	device := inventoryTestDevice("structured-source", "network", "raw", "10.0.0.20:9100", "registry", "")
	device.Capabilities["discovered_via"] = []interface{}{SourceSNMP}
	if got := runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows"); len(got) != 0 {
		t.Fatalf("a legacy structured scan origin was mistaken for operator intent: %#v", got)
	}
}

func TestWindowsAdmissionDoesNotDeleteHistoricalCandidateRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	device := inventoryTestDevice("historical-scan", "network", "raw", "10.0.0.20:9100", "discovery", SourceSNMP)
	if err := SaveRegistry(path, []DeviceInfo{device}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	production, hidden, removed, err := loadRegistryPartitioned(path)
	loaded := concatDevices(production, hidden)
	if err != nil || removed != 0 || len(loaded) != 1 || loaded[0].ID != device.ID {
		t.Fatalf("historical candidate was not recoverable: rows=%#v removed=%d err=%v", loaded, removed, err)
	}
	if got := runtimeInventoryPrintersForPlatform(loaded, "windows"); len(got) != 0 {
		t.Fatalf("historical scan evidence re-entered Windows main fleet: %#v", got)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatalf("main admission deleted or rewrote recoverable scan evidence: %v", err)
	}
}

func TestFriendlyAliasCannotHideSoftwareOrRedirectedQueueEvidence(t *testing.T) {
	for _, queueName := range []string{"Microsoft Print to PDF", "Microsoft XPS Document Writer", "OneNote", "HP LaserJet (redirected 3)"} {
		t.Run(queueName, func(t *testing.T) {
			device := inventoryTestDevice("aliased", "spooler", "spooler", queueName, "manual", SourceSpooler)
			device.Name, device.DisplayName = "Chosen office label", "Chosen office label"
			if !ClassifyDeviceInfo(device).IsVirtual || IsRuntimeDiscoveryPrinter(device) ||
				len(runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows")) != 0 {
				t.Fatalf("a friendly alias hid native software/session queue evidence: %#v", device)
			}
		})
	}
}

func TestFriendlyAliasesKeepPhysicalQueuesWithTheirKnownMetadata(t *testing.T) {
	for _, source := range []string{"manual", "config"} {
		for _, physical := range []struct{ name, driver, port string }{
			{"Canon G4070", "Canon G4070 series", "USB001"},
			{`\\server\Office Queue`, "Microsoft enhanced point and print compatibility driver", `\\server\Office Queue`},
		} {
			t.Run(source+"-"+physical.name, func(t *testing.T) {
				device := inventoryTestDevice("physical-alias", "spooler", "spooler", physical.name, source, SourceSpooler)
				device.Name, device.DisplayName = "Chosen office label", "Chosen office label"
				device.Capabilities["driver_name"], device.Capabilities["port_name"] = physical.driver, physical.port
				if ClassifyDeviceInfo(device).Class != ClassPhysical || !IsRuntimeDiscoveryPrinter(device) ||
					len(runtimeInventoryPrintersForPlatform([]DeviceInfo{device}, "windows")) != 1 {
					t.Fatalf("a physical alias lost its installed queue/driver/port evidence: %#v", device)
				}
			})
		}
	}
}

func TestEndpointOnlySpoolerAliasesStillExposeNativeQueueEvidence(t *testing.T) {
	for _, connection := range []string{"spooler", "windows_spooler", ""} {
		device := DeviceInfo{Name: "Chosen office label", Endpoint: "Microsoft Print to PDF", ConnectionType: connection,
			Type: "spooler", Capabilities: map[string]interface{}{"registration_source": "manual"}}
		if !ClassifyDeviceInfo(device).IsVirtual || IsRuntimeDiscoveryPrinter(device) {
			t.Fatalf("endpoint-only legacy %q spooler alias hid a native writer: %#v", connection, device)
		}
	}
}

func TestDiscoveryNamesUseObservedQueueOrRicherMetadata(t *testing.T) {
	queue := discoveredDeviceNames(DeviceInfo{SpoolerName: "Canon G4070", Name: " "})
	if queue.Name != "Canon G4070" || queue.DisplayName != queue.Name {
		t.Fatalf("blank inventory label ignored the observed native queue: %#v", queue)
	}
	device := discoveredDeviceNames(DeviceInfo{Name: "SNMP Printer 10.0.0.20", DisplayName: "Brother HL-L2350DW"})
	if device.Name != "Brother HL-L2350DW" {
		t.Fatalf("generic candidate name ignored richer observed metadata: %#v", device)
	}
	device.Capabilities = map[string]interface{}{"registration_source": "manual"}
	device.Name = "Network Printer chosen by operator"
	if got := discoveredDeviceNames(device); got.Name != device.Name {
		t.Fatalf("discovery replaced an explicit operator label: %#v", got)
	}
}

func TestRegistryRecoversBlankLabelFromInstalledQueueName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	device := inventoryTestDevice("stable", "spooler", "spooler", "Canon G4070", "discovery", SourceSpooler)
	device.Name, device.DisplayName = "", ""
	device.Capabilities["driver_name"], device.Capabilities["port_name"] = "Canon printer", "USB001"
	if err := SaveRegistry(path, []DeviceInfo{device}); err != nil {
		t.Fatal(err)
	}
	rows, err := LoadRegistryPrinters(path)
	if err != nil || len(rows) != 1 || rows[0].Name != "Canon G4070" || rows[0].ID != "stable" {
		t.Fatalf("blank display label deleted a real named queue: rows=%#v err=%v", rows, err)
	}
}

func TestMergeFillsBlankLabelWithoutChangingStableQueue(t *testing.T) {
	old := inventoryTestDevice("stable", "spooler", "spooler", "Canon G4070", "config", "")
	old.Name, old.DisplayName = "", ""
	observed := inventoryTestDevice("stable", "spooler", "spooler", "Canon G4070", "discovery", SourceSpooler)
	observed.Name, observed.DisplayName = "Canon G4070", "Canon G4070"
	merged := mergeDeviceInfo(old, observed)
	if merged.ID != "stable" || merged.Name != "Canon G4070" || merged.DisplayName != "Canon G4070" ||
		merged.Capabilities["registration_source"] != "config" {
		t.Fatalf("blank-label enrichment lost queue identity/ownership: %#v", merged)
	}
}

func TestQueueMergeKeepsNativeHealthAndAdmissionEvidence(t *testing.T) {
	queue := inventoryTestDevice("stable", "spooler", "spooler", "Office Queue", "manual", SourceSpooler)
	queue.Status = "offline"
	queue.Capabilities["verification"] = "verified"
	queue.Capabilities["supported_protocols"] = []string{"pdf", "image"}
	for _, transport := range []string{"network", "usb"} {
		t.Run(transport, func(t *testing.T) {
			incoming := inventoryTestDevice("stable", transport, "raw", "10.0.0.20:9100", "discovery", SourceSNMP)
			incoming.Status = "online"
			incoming.USBVID = "1234"
			incoming.Capabilities["serial"] = "identity-enrichment"
			incoming.Capabilities["verification"] = "candidate_only"
			incoming.Capabilities["supported_protocols"] = []string{"raw"}
			merged := mergeDeviceInfo(queue, incoming)
			if merged.Status != "offline" || merged.Protocol != "spooler" || merged.Endpoint != "Office Queue" ||
				merged.Capabilities["registration_source"] != "manual" || merged.Capabilities["discovered_via"] != SourceSpooler ||
				merged.Capabilities["verification"] != "verified" || !reflect.DeepEqual(merged.Capabilities["supported_protocols"], []string{"pdf", "image"}) {
				t.Fatalf("foreign transport replaced native evidence/selection: %#v", merged)
			}
			if merged.Capabilities["serial"] != "identity-enrichment" || queue.Capabilities["serial"] != nil {
				t.Fatal("identity enrichment was lost or mutated an earlier snapshot")
			}
			nativeOnline := queue
			nativeOnline.Status, incoming.Status = "online", "offline"
			if got := mergeDeviceInfo(nativeOnline, incoming); got.Status != "online" {
				t.Fatalf("foreign transport poisoned a Windows queue with false offline: %#v", got)
			}
		})
	}
	observed := queue
	observed.Endpoint, observed.Status = "office queue", "error"
	if got := mergeDeviceInfo(queue, observed); got.Status != "error" {
		t.Fatalf("same Windows queue lost current health through a case-only name difference: %#v", got)
	}
}

func TestExplicitDirectSelectionIsNotReplacedByAutomaticQueue(t *testing.T) {
	direct := inventoryTestDevice("stable", "network", "escpos", "10.0.0.20:9100", "manual", SourceSNMP)
	direct.Name, direct.Status = "Front Desk Receipt", "error"
	queue := inventoryTestDevice("stable", "spooler", "spooler", "Windows Queue", "discovery", SourceSpooler)
	queue.Status = "online"
	merged := mergeDeviceInfo(direct, queue)
	if merged.Name != direct.Name || merged.ConnectionType != direct.ConnectionType || merged.Protocol != direct.Protocol ||
		merged.Endpoint != direct.Endpoint || merged.Status != direct.Status || merged.SpoolerName != "" ||
		merged.Capabilities["registration_source"] != "manual" || merged.Capabilities["discovered_via"] != SourceSNMP {
		t.Fatalf("automatic queue rebound the operator's direct printer: %#v", merged)
	}
}

func TestInstalledQueuesNeverMergeByNetworkAddressAlone(t *testing.T) {
	first := inventoryTestDevice("queue-a", "spooler", "spooler", "First Queue", "discovery", SourceSpooler)
	first.NetworkAddress, first.Port = "10.0.0.20", 9100
	second := first
	second.ID, second.Endpoint, second.SpoolerName = "queue-b", "Second Queue", "Second Queue"
	direct := inventoryTestDevice("direct", "network", "raw", "10.0.0.20:9100", "discovery", SourceSNMP)
	direct.NetworkAddress, direct.Port = first.NetworkAddress, first.Port
	if sameNetworkEndpoint(first, second) || sameNetworkEndpoint(first, direct) || sameNetworkEndpoint(direct, first) {
		t.Fatal("shared host/IP conflated distinct installed queue/transport identities")
	}
}
