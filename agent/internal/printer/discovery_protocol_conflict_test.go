package printer

import (
	"path/filepath"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

// Same network socket does not prove which printer byte language is safe.
// A stale registry or a second live discovery result must not arbitrarily
// replace an explicit RAW/ESC-POS/ZPL/TSPL execution protocol.
func TestQuickDiscoveryQuarantinesContradictoryTCPPrintLanguages(t *testing.T) {
	for _, pair := range [][2]string{{"raw", "zpl"}, {"escpos", "tspl"}} {
		t.Run(pair[0]+"_versus_"+pair[1], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "printers.json")
			prior := DeviceInfo{
				ID: "socket-shared-id", Name: "Previous printer",
				ConnectionType: "network", Protocol: pair[0],
				Endpoint: "10.20.30.40:9100", NetworkAddress: "10.20.30.40",
				Port: 9100, PrinterType: "physical", Enabled: true, Status: "online",
				Capabilities: map[string]interface{}{
					"geometry":            map[string]interface{}{"source": "validated_profile"},
					"supported_protocols": []string{pair[0]},
				},
			}
			if err := SaveRegistry(path, []DeviceInfo{prior}); err != nil {
				t.Fatal(err)
			}
			cfg := &config.Config{Printers: []config.PrinterConfig{{
				ID: prior.ID, Name: "Current printer", Type: "network",
				Protocol: pair[1], Endpoint: prior.Endpoint, PrinterType: "physical",
			}}}
			for i := 0; i < 8; i++ {
				rows := DiscoverQuick(cfg, path).Printers
				if len(rows) != 1 {
					t.Fatalf("duplicate or missing logical network endpoint: %+v", rows)
				}
				got := rows[0]
				if got.Capabilities["identity_collision"] != "same_endpoint_different_print_language" ||
					IsRuntimeDiscoveryPrinter(got) || got.Capabilities["geometry"] != nil {
					t.Fatalf("network protocol collision admitted a selected byte language: %+v", got)
				}
			}
		})
	}
}

func TestDiscoveryAllowsUnknownNetworkLanguageToBecomeKnown(t *testing.T) {
	before := DeviceInfo{
		ID: "printer-network", ConnectionType: "network", Protocol: "unknown",
		Endpoint: "10.20.30.40:9100", NetworkAddress: "10.20.30.40",
		Port: 9100, PrinterType: "physical", Capabilities: map[string]interface{}{},
	}
	after := before
	after.Protocol = "escpos"
	got := mergeDiscoveredSameID(before, after)
	if got.Capabilities["identity_collision"] != nil || got.Protocol != "escpos" {
		t.Fatalf("unknown discovery evidence must not block a later explicit protocol: %+v", got)
	}
}

func TestSameIDTCPProtocolConflictWithoutOptionalNetworkAddress(t *testing.T) {
	// Manual registry rows may have only an exact host:port Endpoint. They
	// must still reject a conflicting byte language before any cloud dispatch.
	prior := DeviceInfo{
		ID: "manual-net-id", Name: "Kitchen", ConnectionType: "network",
		Protocol: "raw", Endpoint: "10.20.30.40:9100", PrinterType: "physical",
	}
	later := prior
	later.Protocol = "zpl"
	got := mergeDiscoveredSameID(prior, later)
	if got.Capabilities["identity_collision"] != "same_endpoint_different_print_language" || IsRuntimeDiscoveryPrinter(got) {
		t.Fatalf("unenriched manual endpoint silently accepted conflicting print language: %+v", got)
	}
}
