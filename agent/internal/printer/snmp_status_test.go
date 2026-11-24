package printer

import (
	"context"
	"net"
	"testing"
	"time"
)

// TestInterpretSNMPPrinterStatus pins the Host-Resources printer-table
// mapping: detected-error fault bits block with precise details,
// warnings (low paper/toner) never block, and absent evidence yields
// no verdict at all so callers keep their previous behavior.
func TestInterpretSNMPPrinterStatus(t *testing.T) {
	cases := []struct {
		name       string
		hrStatus   int
		hasHR      bool
		errState   []byte
		hasErr     bool
		wantStatus string
		wantDetail string
	}{
		{"no evidence", 0, false, nil, false, "", ""},
		{"idle clean", 3, true, []byte{0x00, 0x00}, true, "online", "snmp_ok"},
		{"printing clean", 4, true, []byte{0x00, 0x00}, true, "busy", "snmp_printing"},
		{"warmup", 5, true, []byte{0x00, 0x00}, true, "busy", "snmp_warmup"},
		{"no paper blocks", 3, true, []byte{0x40, 0x00}, true, "error", "snmp_no_paper"},
		{"jam blocks", 3, true, []byte{0x04, 0x00}, true, "error", "snmp_paper_jam"},
		{"door open blocks", 3, true, []byte{0x08, 0x00}, true, "error", "snmp_door_open"},
		{"no toner blocks", 3, true, []byte{0x10, 0x00}, true, "error", "snmp_no_toner"},
		{"device offline bit", 3, true, []byte{0x02, 0x00}, true, "offline", "snmp_device_offline"},
		{"service requested blocks", 3, true, []byte{0x01, 0x00}, true, "error", "snmp_service_requested"},
		{"input tray missing blocks", 3, true, []byte{0x00, 0x80}, true, "error", "snmp_input_tray_missing"},
		{"supply missing blocks", 3, true, []byte{0x00, 0x20}, true, "error", "snmp_supply_missing"},
		{"output full blocks", 3, true, []byte{0x00, 0x10}, true, "error", "snmp_output_full"},
		{"low paper warns only", 3, true, []byte{0x80, 0x00}, true, "online", "snmp_low_paper"},
		{"low toner warns only while printing", 4, true, []byte{0x20, 0x00}, true, "busy", "snmp_low_toner"},
		{"fault wins over unknown hr status", 2, true, []byte{0x40, 0x00}, true, "error", "snmp_no_paper"},
		{"unknown hr status alone is no verdict", 2, true, nil, false, "", ""},
		{"clean error state without hr status is a positive report", 0, false, []byte{0x00, 0x00}, true, "online", "snmp_no_errors"},
		{"fault without hr status", 0, false, []byte{0x04, 0x00}, true, "error", "snmp_paper_jam"},
		{"empty error state is no evidence", 0, false, []byte{}, true, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, detail := interpretSNMPPrinterStatus(tc.hrStatus, tc.hasHR, tc.errState, tc.hasErr)
			if status != tc.wantStatus || detail != tc.wantDetail {
				t.Fatalf("want %q/%q got %q/%q", tc.wantStatus, tc.wantDetail, status, detail)
			}
		})
	}
}

// TestNetworkPrinterStatusUsesSNMPWhenAvailable pins the wiring: a
// reachable raw printer whose SNMP table reports a fault surfaces the
// fault (previously it could only ever say "unknown"), and a device
// that does not answer SNMP keeps the old "unknown".
func TestNetworkPrinterStatusUsesSNMPWhenAvailable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()

	original := snmpStatusProbe
	defer func() { snmpStatusProbe = original }()

	snmpStatusProbe = func(ctx context.Context, host string) (string, string, bool) {
		return "error", "snmp_paper_jam", true
	}
	p := &NetworkPrinter{Address: listener.Addr().String(), Protocol: "raw"}
	if got := p.Status(); got != "error" {
		t.Fatalf("SNMP jam should surface as error, got %q", got)
	}
	if got := p.StatusDetail(); got != "snmp_paper_jam" {
		t.Fatalf("StatusDetail: want snmp_paper_jam got %q", got)
	}

	snmpStatusProbe = func(ctx context.Context, host string) (string, string, bool) {
		return "", "", false
	}
	p2 := &NetworkPrinter{Address: listener.Addr().String(), Protocol: "raw"}
	if got := p2.Status(); got != "unknown" {
		t.Fatalf("no SNMP answer must keep unknown, got %q", got)
	}
	// A second call within the negative-cache window must not probe again.
	probes := 0
	snmpStatusProbe = func(ctx context.Context, host string) (string, string, bool) {
		probes++
		return "", "", false
	}
	p2.Status()
	if probes != 0 {
		t.Fatalf("negative cache should suppress repeat probes, got %d probes", probes)
	}

	// Connection refusal stays "offline" and never reaches SNMP.
	probeCalled := false
	snmpStatusProbe = func(ctx context.Context, host string) (string, string, bool) {
		probeCalled = true
		return "online", "snmp_ok", true
	}
	dead := &NetworkPrinter{Address: "127.0.0.1:1", Protocol: "raw"}
	start := time.Now()
	if got := dead.Status(); got != "offline" {
		t.Fatalf("refused connection must stay offline, got %q", got)
	}
	if probeCalled {
		t.Fatal("SNMP must not be probed when the print port itself refuses")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("offline path took too long")
	}
}
