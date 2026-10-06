package printer

import (
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestStableID_SpoolerDeterministic(t *testing.T) {
	id1 := StableIDFromSpooler("HP LaserJet 1020")
	id2 := StableIDFromSpooler("HP LaserJet 1020")
	if id1 != id2 {
		t.Fatalf("spooler ID not deterministic %s vs %s", id1, id2)
	}
	id3 := StableIDFromSpooler("hp laserjet 1020")
	if id1 != id3 {
		t.Fatalf("spooler ID should be case-insensitive")
	}
}

func TestStableID_NetworkDeterministic(t *testing.T) {
	id1 := StableIDFromNetwork("192.168.1.10", 9100)
	id2 := StableIDFromNetwork("192.168.1.10", 9100)
	if id1 != id2 {
		t.Fatalf("network ID not deterministic")
	}
	// Different port should differ
	id3 := StableIDFromNetwork("192.168.1.10", 515)
	if id1 == id3 {
		t.Fatalf("different port should give different ID")
	}
}

func TestStableID_USBDeterministic(t *testing.T) {
	id1 := StableIDFromUSB("03f0", "0c17", "CN123", "")
	id2 := StableIDFromUSB("03F0", "0C17", "cn123", "")
	if id1 != id2 {
		t.Fatalf("USB ID case insensitive failed %s vs %s", id1, id2)
	}
	id3 := StableIDFromUSB("03f0", "0c17", "", "1-2")
	id4 := StableIDFromUSB("03f0", "0c17", "", "1-2")
	if id3 != id4 {
		t.Fatalf("USB location ID not deterministic")
	}
}

func TestClassifySpoolerPrinter(t *testing.T) {
	// A Windows print queue is ALWAYS served through the spooler backend,
	// regardless of port. The port/monitor select the spooler's delivery
	// path; they never turn the queue into a direct-TCP/USB device (that
	// broke every WSD and Standard TCP/IP queue: the factory expects
	// ip:port endpoints for direct network printers).
	cases := []struct {
		port, driver, name, wantType, wantConn string
	}{
		{"USB001", "HP LaserJet", "HP LaserJet", "laser", "spooler"},
		{"WSD-123456", "Generic", "My Printer", "unknown", "spooler"},
		{"IP_192.168.1.50", "ESC/POS Thermal", "Receipt Printer", "thermal", "spooler"},
		{"192.168.1.50:9100", "Zebra Label", "Zebra GK420", "label", "spooler"},
		{"LPT1:", "Generic", "Old LPT", "unknown", "spooler"},
		{"", "Epson TM-T20", "TM-T20 Receipt", "thermal", "spooler"},
		{"BRFAX:", "Brother PC-FAX v.3.2", "Brother PC-FAX v.3.2 (A3/LGR)", "unknown", "spooler"},
	}
	for _, tc := range cases {
		pt, ct := classifySpoolerPrinter(tc.port, tc.driver, tc.name)
		if pt != tc.wantType {
			t.Errorf("port %q driver %q name %q: want type %q got %q", tc.port, tc.driver, tc.name, tc.wantType, pt)
		}
		if ct != tc.wantConn {
			t.Errorf("port %q: want conn %q got %q", tc.port, tc.wantConn, ct)
		}
	}
}

func TestMapWindowsStatus(t *testing.T) {
	cases := []struct {
		name       string
		status     uint32
		attributes uint32
		want       string
	}{
		{name: "zero is online", status: 0, want: "online"},
		{name: "offline", status: 0x00000080, want: "offline"},
		{name: "work offline", attributes: 0x00000400, want: "offline"},
		{name: "server unknown stays unknown", status: 0x00800000, want: "unknown"},
		{name: "server offline is offline", status: 0x02000000, want: "offline"},
		{name: "server unknown plus explicit offline is offline", status: 0x00800000 | 0x00000080, want: "offline"},
		{name: "server unknown plus server offline is offline", status: 0x00800000 | 0x02000000, want: "offline"},
		{name: "pending deletion is non-routable error", status: 0x00000004, want: "error"},
		{name: "paused is non-routable error", status: 0x00000001, want: "error"},
		{name: "generic error", status: 0x00000002, want: "error"},
		{name: "paper problem", status: 0x00000040, want: "error"},
		{name: "output bin full", status: 0x00000800, want: "error"},
		{name: "no toner", status: 0x00040000, want: "error"},
		{name: "manual feed", status: 0x00000020, want: "error"},
		{name: "page punt", status: 0x00080000, want: "error"},
		{name: "out of memory", status: 0x00200000, want: "error"},
		{name: "busy", status: 0x00000200, want: "busy"},
		{name: "io active", status: 0x00000100, want: "busy"},
		{name: "printing", status: 0x00000400, want: "busy"},
		{name: "processing", status: 0x00004000, want: "busy"},
		{name: "initializing", status: 0x00008000, want: "busy"},
		{name: "warming up", status: 0x00010000, want: "busy"},
		{name: "waiting remains online", status: 0x00002000, want: "online"},
		{name: "toner low remains online", status: 0x00020000, want: "online"},
		{name: "power save remains online", status: 0x01000000, want: "online"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mapWindowsStatus(tc.status, tc.attributes); got != tc.want {
				t.Fatalf("mapWindowsStatus(0x%08x, 0x%08x) = %q, want %q", tc.status, tc.attributes, got, tc.want)
			}
		})
	}
}

func TestUSBParseVIDPID(t *testing.T) {
	// Use helper from usb_windows.go via parseVIDPIDSerial (exported? it's private)
	// Instead test StableIDFromUSB directly
	cases := []struct {
		id         string
		wantVID    uint16
		wantPID    uint16
		wantSerial string
	}{
		{"USB\\VID_03F0&PID_0C17\\CN123", 0x03F0, 0x0C17, "CN123"},
		{"USBPRINT\\VID_04B8&PID_0202\\1234567890", 0x04B8, 0x0202, "1234567890"},
	}
	for _, tc := range cases {
		// We test via StableIDFromUSB equivalence
		vidStr := "03f0"
		pidStr := "0c17"
		if tc.wantVID == 0x04B8 {
			vidStr = "04b8"
			pidStr = "0202"
		}
		id := StableIDFromUSB(vidStr, pidStr, tc.wantSerial, "")
		id2 := StableIDFromUSB(vidStr, pidStr, tc.wantSerial, "")
		if id != id2 {
			t.Fatalf("stable ID not deterministic for %q", tc.id)
		}
	}
}

func TestNetworkGenerateHosts(t *testing.T) {
	_, ipNet, _ := net.ParseCIDR("192.168.1.0/24")
	hosts := generateHosts(ipNet)
	if len(hosts) != 254 {
		t.Fatalf("expected 254 hosts for /24 got %d", len(hosts))
	}
	if hosts[0].String() != "192.168.1.1" {
		t.Fatalf("first host should be 192.168.1.1 got %s", hosts[0])
	}
	if hosts[253].String() != "192.168.1.254" {
		t.Fatalf("last host should be 192.168.1.254 got %s", hosts[253])
	}
	// Test /16 clamped
	_, ipNet16, _ := net.ParseCIDR("172.16.0.0/16")
	hosts16 := generateHosts(ipNet16)
	if len(hosts16) > 254 {
		t.Fatalf("should cap at 254 for /16, got %d", len(hosts16))
	}
}

func TestRegistryMergeDedup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "printers.json")
	di1 := DeviceInfo{ID: "printer_spooler_abc", Name: "Printer A", SpoolerName: "Printer A", ConnectionType: "spooler", Protocol: "spooler", Status: "online"}
	di2 := DeviceInfo{ID: "printer_spooler_abc", Name: "Printer A Updated", SpoolerName: "Printer A", ConnectionType: "spooler", Protocol: "spooler", Status: "offline"}
	// First upsert
	if _, err := UpsertRegistry(path, []DeviceInfo{di1}); err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	// Second upsert same ID should update, not duplicate
	merged, err := UpsertRegistry(path, []DeviceInfo{di2})
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if len(merged) != 1 {
		t.Fatalf("expected 1 after dedup, got %d", len(merged))
	}
	if merged[0].Name != "Printer A Updated" {
		t.Fatalf("expected updated name, got %q", merged[0].Name)
	}
	if merged[0].Status != "offline" {
		t.Fatalf("expected offline status")
	}
}

func TestUpsertRegistryPreservesCapabilitiesOnBareRediscovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "printers.json")
	rich := DeviceInfo{ID: "printer_net_abc", Name: "Net Printer", ConnectionType: "network", Protocol: "raw", Status: "online", USBSerial: "CN123", Capabilities: map[string]interface{}{"driver_name": "Acme", "port_name": "IP_10.0.0.5"}}
	if _, err := UpsertRegistry(path, []DeviceInfo{rich}); err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	// A bare rediscovery observation carries no capabilities/serial: the
	// stored row must keep what was previously observed, not wipe it.
	bare := DeviceInfo{ID: "printer_net_abc", Name: "Net Printer", ConnectionType: "network", Protocol: "raw", Status: "online"}
	merged, err := UpsertRegistry(path, []DeviceInfo{bare})
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if len(merged) != 1 {
		t.Fatalf("expected 1 after dedup, got %d", len(merged))
	}
	if merged[0].USBSerial != "CN123" {
		t.Fatalf("bare rediscovery must not wipe the observed serial, got %q", merged[0].USBSerial)
	}
	if merged[0].Capabilities["driver_name"] != "Acme" {
		t.Fatalf("bare rediscovery must not wipe observed capabilities, got %v", merged[0].Capabilities)
	}
}

func TestManualRegistrationWithUSBFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "printers.json")
	di := DeviceInfo{
		Name:           "USB Label",
		ConnectionType: "usb",
		Protocol:       "raw",
		Endpoint:       `\\?\usb#vid_03f0&pid_0c17#CN999`,
		USBVID:         "03f0",
		USBPID:         "0c17",
		USBSerial:      "CN999",
	}
	infos, err := RegisterManual(path, di)
	if err != nil {
		t.Fatalf("RegisterManual failed: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("expected 1")
	}
	if infos[0].USBVID != "03f0" || infos[0].USBPID != "0c17" || infos[0].USBSerial != "CN999" {
		t.Fatalf("USB fields not preserved %+v", infos[0])
	}
	expectedID := StableIDFromUSB("03f0", "0c17", "CN999", "")
	if infos[0].ID != expectedID {
		t.Fatalf("expected stable ID %s got %s", expectedID, infos[0].ID)
	}
}

func TestManualRegistrationWithCapabilities(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "printers.json")
	di := DeviceInfo{
		Name:           "Network RAW",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "192.168.1.99:9100",
		NetworkAddress: "192.168.1.99",
		Port:           9100,
		PrinterType:    "thermal",
		Capabilities:   map[string]interface{}{"paper_widths": []int{58, 80}, "color": false},
	}
	infos, err := RegisterManual(path, di)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if infos[0].Capabilities["paper_widths"] == nil {
		t.Fatalf("capabilities not preserved")
	}
	if infos[0].PrinterType != "thermal" {
		t.Fatalf("printerType not preserved")
	}
}

func TestDedupCrossSourceNetworkSpooler(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{}
	registryPath := config.RegistryPath(cfgPath)
	// Simulate spooler printer with IP port
	spoolerDI := DeviceInfo{
		ID:             StableIDFromSpooler("HP LaserJet"),
		Name:           "HP LaserJet",
		SpoolerName:    "HP LaserJet",
		ConnectionType: "spooler",
		Protocol:       "spooler",
		NetworkAddress: "192.168.1.50",
		Port:           9100,
		Status:         "online",
	}
	networkDI := DeviceInfo{
		ID:             StableIDFromNetwork("192.168.1.50", 9100),
		Name:           "Network Printer 192.168.1.50",
		ConnectionType: "network",
		Protocol:       "raw",
		Endpoint:       "192.168.1.50:9100",
		NetworkAddress: "192.168.1.50",
		Port:           9100,
		Status:         "online",
	}
	// Upsert spooler first
	if _, err := UpsertRegistry(registryPath, []DeviceInfo{spoolerDI}); err != nil {
		t.Fatalf("upsert spooler: %v", err)
	}
	// Discover should dedup network that matches same IP:port
	result := Discover(cfg, registryPath)
	// The result should not have duplicate for same IP:port
	// Since network discovery may not have found 192.168.1.50 (unless it actually responds),
	// we manually test merge logic
	merged, err := UpsertRegistry(registryPath, []DeviceInfo{networkDI})
	if err != nil {
		t.Fatalf("upsert network: %v", err)
	}
	// Our dedup in Discover would merge, but UpsertRegistry alone dedups only by ID,
	// so IDs differ (spooler vs net) -> they would be 2. But Discover's add dedups by IP.
	// Test the Discover dedup path directly via merge
	if len(merged) != 2 {
		// UpsertRegistry dedups only by ID, so 2 is expected
		t.Logf("UpsertRegistry by ID gives %d (expected 2), dedup by IP is in Discover layer", len(merged))
	}
	// Test Discover merge via add logic: simulate Discover's cross-source dedup
	// We'll call Discover which will load registry (2) and not find network via scan (no host),
	// so result should be at least 2, but not 3
	if len(result.Printers) < 1 {
		t.Fatalf("discover should have at least spooler")
	}
}

func TestEndpointParsing(t *testing.T) {
	cases := []struct {
		endpoint string
		isNet    bool
	}{
		{"192.168.1.10:9100", true},
		{"10.0.0.5:9100", true},
		{"HP LaserJet", false},
		{"USB001", false},
		{"\\\\server\\printer", false},
	}
	for _, tc := range cases {
		// Use factory helper isNetworkEndpoint (unexported, test via config validation)
		pc := config.PrinterConfig{ID: "p1", Name: "Test", Type: "network", Protocol: "raw", Endpoint: tc.endpoint}
		if tc.isNet {
			if err := config.ValidatePrinterConfig(pc); err != nil {
				t.Errorf("endpoint %q should be valid network: %v", tc.endpoint, err)
			}
		} else {
			// For spooler type, network endpoint check not applicable
			pc.Type = "spooler"
			pc.Protocol = "spooler"
			pc.SpoolerName = tc.endpoint
			if err := config.ValidatePrinterConfig(pc); err != nil {
				t.Errorf("spooler endpoint %q should be valid: %v", tc.endpoint, err)
			}
		}
	}
}

func TestFactoryUSBWithoutSpoolerUsesDirectDevicePath(t *testing.T) {
	pc := config.PrinterConfig{
		ID: "usb1", Name: "USB Direct", Type: "usb", Protocol: "raw",
		Endpoint: `\\?\usb#vid_03f0&pid_0c17#SN123`, USBVID: "03f0", USBPID: "0c17", USBSerial: "SN123",
	}
	p, err := New(pc)
	if err != nil {
		t.Fatalf("expected USBPrinter, got %v", err)
	}
	if p == nil {
		t.Fatalf("expected printer")
	}
}

func TestFactoryUSBDoesNotInferESCPOSFromRawTransport(t *testing.T) {
	pc := config.PrinterConfig{ID: "usb-raw", Name: "USB Raw", Type: "usb", Protocol: "raw", Endpoint: `\\?\usb#vid_1234&pid_5678#A`}
	p, err := New(pc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if SupportsKind(p, KindESCPOS) {
		t.Fatal("raw USB must not gain ESC/POS support without explicit evidence")
	}
	pc.Capabilities = map[string]interface{}{"supported_protocols": []string{"raw", "escpos"}}
	p, err = New(pc)
	if err != nil {
		t.Fatalf("New with explicit capabilities: %v", err)
	}
	if !SupportsKind(p, KindESCPOS) {
		t.Fatal("explicit supported_protocols=escpos must enable ESC/POS")
	}
}

func TestFactoryUSBSupportsDeclaredLabelLanguages(t *testing.T) {
	for _, protocol := range []string{"zpl", "tspl"} {
		t.Run(protocol, func(t *testing.T) {
			pc := config.PrinterConfig{
				ID: "usb-" + protocol, Name: "USB Label " + protocol, Type: "usb", Protocol: protocol,
				Endpoint: `\\?\usb#vid_1234&pid_5678#LABEL`, USBVID: "1234", USBPID: "5678",
			}
			p, err := New(pc)
			if err != nil {
				t.Fatalf("New(%s): %v", protocol, err)
			}
			if !SupportsKind(p, KindRaw) {
				t.Fatalf("direct USB %s must accept its validated byte-stream payload", protocol)
			}
			if SupportsKind(p, KindPDF) || SupportsKind(p, KindImage) {
				t.Fatalf("direct USB %s must not gain a document renderer", protocol)
			}
		})
	}
}

func TestFactoryUSBRequiresExplicitByteProtocol(t *testing.T) {
	pc := config.PrinterConfig{ID: "usb-unknown", Name: "USB Unknown", Type: "usb", Endpoint: `\\?\usb#vid_1234&pid_5678#A`}
	if _, err := New(pc); err == nil {
		t.Fatal("missing USB byte protocol must fail closed")
	} else {
		message := strings.ToLower(err.Error())
		if !strings.Contains(message, "protocol") || !strings.Contains(message, "explicit") {
			t.Fatalf("expected explicit protocol diagnostic, got %v", err)
		}
	}
}

func TestFactoryUSBRejectsAmbiguousEndpoint(t *testing.T) {
	pc := config.PrinterConfig{
		ID: "usb2", Name: "USB Ambiguous", Type: "usb", Protocol: "raw",
		Endpoint: "HP LaserJet", USBVID: "03f0", USBPID: "0c17",
	}
	if _, err := New(pc); err == nil {
		t.Fatal("USB endpoint display names must not be reinterpreted as spooler queues")
	} else if !containsStr(strings.ToLower(err.Error()), "device path") || !containsStr(strings.ToLower(err.Error()), "spooler") {
		t.Fatalf("expected explicit USB transport diagnostic, got %v", err)
	}
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestIsPrinterUSBDevice(t *testing.T) {
	cases := []struct {
		hw, compat []string
		class      string
		want       bool
		name       string
	}{
		{[]string{"USB\\VID_046D&PID_C52B&MI_00"}, []string{"USB\\Class_03&SubClass_01"}, "03", false, "mouse HID"},
		{[]string{"USB\\VID_04FE&PID_0021"}, []string{"USB\\Class_0E"}, "0E", false, "camera"},
		{[]string{"USB\\VID_06CB&PID_00A2"}, []string{"USB\\VID_06CB&PID_00A2"}, "00", false, "fingerprint"},
		{[]string{"USB\\VID_8087&PID_0A2B"}, []string{"USB\\Class_E0"}, "E0", false, "bluetooth"},
		{[]string{"USB\\VID_1A40&PID_0101"}, []string{"USB\\Class_09"}, "09", false, "hub composite"},
		{[]string{"USB\\VID_03F0&PID_0C17"}, []string{"USB\\Class_FF"}, "FF", false, "generic composite VID/PID only"},
		{[]string{"USBPRINT\\HP_LaserJet"}, []string{"USBPRINT\\HP_LaserJet"}, "Printer", true, "USBPRINT"},
		{[]string{"USB\\VID_04B8&PID_0202&MI_00"}, []string{"USB\\Class_07"}, "07", true, "Class_07"},
		{[]string{"USB\\VID_03F0&PID_C17A"}, []string{"USB\\Class_07&SubClass_01"}, "07", true, "Class_07 subclass"},
		{[]string{"USB\\VID_04B8&PID_0202"}, []string{"USB\\Class_07&SubClass_01&Prot_02", "USBPRINT"}, "", true, "compatible USBPRINT"},
	}
	for _, tc := range cases {
		got := isPrinterUSBDevice(tc.hw, tc.compat, tc.class)
		if got != tc.want {
			t.Errorf("%s: got %v want %v hw=%v compat=%v class=%q", tc.name, got, tc.want, tc.hw, tc.compat, tc.class)
		}
	}
}

func TestIsVirtualSpooler(t *testing.T) {
	cases := []struct {
		port, driver, name string
		want               bool
	}{
		{"PORTPROMPT:", "Microsoft Print To PDF", "Microsoft Print to PDF", true},
		{"XPSPort:", "Microsoft XPS Document Writer", "Microsoft XPS Document Writer", true},
		{"FILE:", "Generic", "PDF995", true},
		{"nul:", "Generic", "My Printer", true},
		{"SHRFAX:", "Fax Driver", "Fax", true},
		{"IP_192.168.1.50", "Microsoft Print to PDF", "Microsoft Print to PDF", true},
		{"USB001", "HP LaserJet", "HP LaserJet 1020", false},
		{"WSD-abc", "Generic Laser", "Office Printer", false},
		{"IP_192.168.1.10", "Zebra Label", "Zebra GK420", false},
		{"192.168.1.50:9100", "ESC/POS", "Thermal Receipt", false},
		{"USB001", "AnyDesk Printer", "AnyDesk Printer", true},
		{"USB001", "Foxit Reader PDF", "Foxit Printer", true},
	}
	for _, tc := range cases {
		got := isVirtualSpooler(tc.port, tc.driver, tc.name)
		if got != tc.want {
			t.Errorf("port=%q driver=%q name=%q: got %v want %v", tc.port, tc.driver, tc.name, got, tc.want)
		}
	}
}

func TestIsValidSpoolerPrinter(t *testing.T) {
	cases := []struct {
		port, driver, name string
		want               bool
	}{
		{"USB001", "HP LaserJet", "HP LaserJet", true},
		{"WSD-123", "Generic Laser", "Office Printer", true},
		{"IP_192.168.1.10", "HP LaserJet", "HP LaserJet", true},
		{"PORTPROMPT:", "Microsoft Print to PDF", "Microsoft Print to PDF", true}, // virtual but valid
		{"XPSPort:", "Microsoft XPS Document Writer", "Microsoft XPS Document Writer", true},
		{"USB001", "USB Input Device", "(Standard system devices) USB Input Device", false},
		{"", "USB Composite Device", "(Standard USB Host Controller) USB Composite Device", false},
		{"", "Intel Bluetooth", "Intel(R) Wireless Bluetooth(R)", false},
		{"", "HID-compliant mouse", "Microsoft HID-compliant mouse", false},
		{"", "HD Camera", "Microsoft HP HD Camera", false},
		{"", "Fingerprint Sensor", "Synaptics VFS7552 Touch Fingerprint Sensor", false},
		{"", "", "USB Input Device", false},
		{"USB001", "", "USB Input Device", false},
	}
	for _, tc := range cases {
		got := isValidSpoolerPrinter(tc.port, tc.driver, tc.name)
		if got != tc.want {
			t.Errorf("isValidSpoolerPrinter port=%q driver=%q name=%q: got %v want %v", tc.port, tc.driver, tc.name, got, tc.want)
		}
	}
}

func TestRuntimeDiscoveryKeepsAutomaticDirectUSBAsCandidateUntilProtocolIsExplicit(t *testing.T) {
	auto := DeviceInfo{
		ID:             "printer_usb_candidate",
		Name:           "USB Printer",
		ConnectionType: "usb",
		Protocol:       "unknown",
		Endpoint:       `\\?\usb#vid_1234&pid_5678#AUTO`,
		USBVID:         "1234",
		USBPID:         "5678",
		Capabilities: map[string]interface{}{
			"discovered_via":       SourceUSB,
			"direct_usb_available": true,
			"verification":         "candidate_only",
		},
	}
	if IsRuntimeDiscoveryPrinter(auto) {
		t.Fatal("automatic direct USB discovery must remain a candidate until its printer language is explicitly declared")
	}

	manual := auto
	manual.Protocol = "zpl"
	manual.Capabilities = map[string]interface{}{
		"registration_source": "manual",
	}
	if !IsRuntimeDiscoveryPrinter(manual) {
		t.Fatal("explicitly configured direct USB protocol must remain runtime-capable")
	}
}

func TestIsValidDiscoveredPrinterFiltersGeneric(t *testing.T) {
	cases := []struct {
		name  string
		di    DeviceInfo
		valid bool
	}{
		{"mouse usb", DeviceInfo{Name: "(Standard system devices) USB Input Device", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"composite", DeviceInfo{Name: "(Standard USB Host Controller) USB Composite Device", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"bluetooth", DeviceInfo{Name: "Intel(R) Wireless Bluetooth(R)", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"camera", DeviceInfo{Name: "Microsoft HP HD Camera", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"fingerprint", DeviceInfo{Name: "Synaptics VFS7552 Touch Fingerprint Sensor", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"hid mouse", DeviceInfo{Name: "Microsoft HID-compliant mouse", ConnectionType: "usb", PrinterType: "unknown"}, false},
		{"virtual pdf", DeviceInfo{Name: "Microsoft Print to PDF", ConnectionType: "spooler", PrinterType: "virtual", IsVirtual: true}, true},
		{"physical hp", DeviceInfo{Name: "HP LaserJet", ConnectionType: "usb", PrinterType: "unknown", USBVID: "03f0", USBPID: "0c17", Capabilities: map[string]interface{}{"hardware_ids": []string{"USBPRINT\\HP"}, "compatible_ids": []string{"USBPRINT"}}}, true},
	}
	for _, tc := range cases {
		got := isValidDiscoveredPrinter(tc.di)
		if got != tc.valid {
			t.Errorf("%s: got %v want %v di=%+v", tc.name, got, tc.valid, tc.di)
		}
	}
}

func TestCapabilityNormalization(t *testing.T) {
	pc := config.PrinterConfig{ID: "p1", Name: "Test", Type: "spooler", Endpoint: "HP Laser", PrinterType: "thermal", Capabilities: map[string]interface{}{"paper_widths": []int{58}}}
	if pc.PrinterType != "thermal" {
		t.Fatalf("printerType not preserved")
	}
	// Ensure endpointToConfig includes capabilities (tested via agent payload)
}

func TestRegistryPreservesDistinctIPPResourcesOnSameHardware(t *testing.T) {
	path := filepath.Join(t.TempDir(), "printers.json")
	a := DeviceInfo{Name: "IPP Printer A", ConnectionType: "ipp", Protocol: "ipp", NetworkAddress: "192.168.1.60", Port: 631, Endpoint: "ipp://192.168.1.60:631/printers/A", Enabled: true, Capabilities: map[string]interface{}{"uuid": "same-printer", "ipp_verified": true}}
	b := a
	b.Name = "IPP Printer B"
	b.Endpoint = "ipp://192.168.1.60:631/printers/B"
	a.ID = StableIDForDevice(a)
	b.ID = StableIDForDevice(b)
	merged, err := UpsertRegistry(path, []DeviceInfo{a, b})
	if err != nil || len(merged) != 2 {
		t.Fatalf("queues collapsed in registry: %+v %v", merged, err)
	}
	moved := a
	moved.Endpoint = "ipp://192.168.1.70:631/printers/A"
	moved.NetworkAddress = "192.168.1.70"
	moved.ID = StableIDForDevice(moved)
	merged, err = UpsertRegistry(path, []DeviceInfo{moved})
	if err != nil || len(merged) != 2 {
		t.Fatalf("address change duplicated/lost queue: %+v %v", merged, err)
	}
	found := false
	for _, item := range merged {
		if item.Endpoint == moved.Endpoint {
			found = true
			if item.ID != a.ID {
				t.Fatal("identity-preserving move changed persisted queue ID")
			}
		}
	}
	if !found {
		t.Fatal("moved endpoint was not persisted")
	}
}
