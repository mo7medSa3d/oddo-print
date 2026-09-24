package printer

import "testing"

// Hot-path microbenchmarks for printer capability, classification, media
// normalization, and stable-ID (discovery dedup) helpers.
//
// These operations run during discovery (once per discovered device, and again
// on every refresh) and during job validation (once per job, on the dispatch
// latency path). They are pure/CPU-bound and safe to benchmark without any
// network or hardware.
//
// Run with:
//
//	go test -bench=. -benchmem ./internal/printer/
//
// Microbenchmarks measure CPU/alloc cost only, not end-to-end print latency.

var (
	benchThermalTCP = TransportFacts{
		Protocol:          "escpos",
		Connection:        "tcp",
		SupportedProtocol: []string{"raw", "escpos"},
	}
	benchLaserIPP = TransportFacts{
		Protocol:          "ipp",
		Connection:        "tcp",
		SupportedProtocol: []string{"ipp", "pdf"},
	}
)

func BenchmarkPayloadCompatible_ThermalMatch(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if ok, _ := PayloadCompatibleForDevice("escpos", "escpos", benchThermalTCP); !ok {
			b.Fatal("expected compatible")
		}
	}
}

func BenchmarkPayloadCompatible_Mismatch(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		// PDF payload against a raw/escpos thermal transport: rejection path.
		_, _ = PayloadCompatibleForDevice("pdf", "pdf", benchThermalTCP)
	}
}

func BenchmarkSupportedProtocolsForDevice(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = SupportedProtocolsForDevice(benchLaserIPP)
	}
}

func BenchmarkRasterMaxWidthFromCapabilities(b *testing.B) {
	caps := map[string]interface{}{
		"max_paper_width": 576, // 80mm @ 203dpi in dots
		"supports_color":  false,
		"paper_widths":    []interface{}{58, 80},
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = RasterMaxWidthFromCapabilities(caps)
	}
}

func benchDeviceNetwork() DeviceInfo {
	return DeviceInfo{
		Name:           "Epson TM-T88VI",
		PrinterType:    "thermal",
		ConnectionType: "tcp",
		Protocol:       "escpos",
		Endpoint:       "192.168.1.50:9100",
		NetworkAddress: "192.168.1.50",
		Port:           9100,
		Status:         "online",
		Enabled:        true,
	}
}

func benchDeviceUSB() DeviceInfo {
	return DeviceInfo{
		Name:           "Star TSP143",
		PrinterType:    "thermal",
		ConnectionType: "usb",
		Protocol:       "escpos",
		USBVID:         "0519",
		USBPID:         "0003",
		USBSerial:      "SN12345",
		Status:         "online",
		Enabled:        true,
	}
}

// StableIDForDevice is the discovery-dedup key: two probes of the same physical
// device must resolve to the same ID so duplicates collapse.
func BenchmarkStableIDForDevice_Network(b *testing.B) {
	d := benchDeviceNetwork()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = StableIDForDevice(d)
	}
}

func BenchmarkStableIDForDevice_USB(b *testing.B) {
	d := benchDeviceUSB()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = StableIDForDevice(d)
	}
}

func BenchmarkClassifyDeviceInfo(b *testing.B) {
	d := benchDeviceNetwork()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = ClassifyDeviceInfo(d)
	}
}

// Discovery dedup at realistic scale: N raw probe results (with duplicates)
// collapsed by stable ID. Models the map-keyed dedup done during a discovery
// sweep.
func BenchmarkDiscoveryDedup_200(b *testing.B) {
	base := []DeviceInfo{benchDeviceNetwork(), benchDeviceUSB()}
	probes := make([]DeviceInfo, 0, 200)
	for i := 0; i < 100; i++ {
		probes = append(probes, base[0], base[1]) // each device probed twice
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		seen := make(map[string]struct{}, len(probes))
		unique := 0
		for j := range probes {
			id := StableIDForDevice(probes[j])
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			unique++
		}
		if unique != 2 {
			b.Fatalf("expected 2 unique devices, got %d", unique)
		}
	}
}
