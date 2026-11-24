package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestOperationalVerificationSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/printer-operational-verification-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Now        string `json:"now"`
		ProofCases []struct {
			Name    string
			Printer struct{ ID, ConnectionType, Protocol string }
			Proof   json.RawMessage
			Valid   bool
		} `json:"proofCases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range fixture.ProofCases {
		t.Run(test.Name, func(t *testing.T) {
			pc := config.PrinterConfig{ID: test.Printer.ID, Type: test.Printer.ConnectionType, Protocol: test.Printer.Protocol}
			switch pc.NormalizedType() {
			case "spooler":
				pc.Endpoint, pc.SpoolerName = "Office Queue", "Office Queue"
			case "ipp", "ipps":
				pc.Endpoint = pc.NormalizedType() + "://10.0.0.20/ipp/print"
			case "usb":
				pc.Endpoint = `\\?\usb#vid_1234&pid_5678#serial#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`
				pc.USBVID, pc.USBPID, pc.USBSerial = "1234", "5678", "serial"
			default:
				pc.Endpoint = "10.0.0.20:9100"
			}
			binding, bindErr := config.PrinterBindingDigest(pc)
			var proof *OperationalVerification
			decoder := json.NewDecoder(bytes.NewReader(test.Proof))
			decoder.DisallowUnknownFields()
			parseErr := decoder.Decode(&proof)
			if parseErr == nil && proof != nil {
				// Fixtures use one opaque valid digest. The native side additionally
				// knows the actual endpoint; substitute only that exact valid token.
				if proof.BindingDigest == strings.Repeat("a", 64) {
					proof.BindingDigest = binding
				}
				if proof.LogicalQueueKey == strings.Repeat("a", 64) {
					proof.LogicalQueueKey = binding
				}
			}
			valid := parseErr == nil && bindErr == nil && proof.Validate(pc, now) == nil
			if valid != test.Valid {
				t.Fatalf("native proof validity=%v want=%v, parse=%v bind=%v proof=%+v", valid, test.Valid, parseErr, bindErr, proof)
			}
		})
	}
}

func TestOperationalIPPProbeUsesActualAttributesAndNeverSubmitsDocument(t *testing.T) {
	for _, mode := range []string{"valid", "html-service", "missing-state", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			var probes, submissions atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body := readAll(r.Body)
				if len(body) < 8 || binary.BigEndian.Uint16(body[2:4]) != 0x000b {
					submissions.Add(1)
					http.Error(w, "no output allowed", 500)
					return
				}
				probes.Add(1)
				if mode == "html-service" {
					w.Header().Set("Content-Type", "text/html")
					_, _ = w.Write([]byte("<html>not a printer</html>"))
					return
				}
				response := bytes.NewBuffer(ippIdentityFixture(ippIdentityFixtureUUID))
				response.Truncate(response.Len() - 1)
				if mode != "missing-state" {
					state := 3
					if mode == "stopped" {
						state = 5
					}
					writeIPPIntAttr(response, 0x23, "printer-state", int32(state))
				}
				response.WriteByte(3)
				w.Header().Set("Content-Type", "application/ipp")
				_, _ = w.Write(response.Bytes())
			}))
			defer server.Close()
			previous := ippDirectTransport
			transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
			}}
			ippDirectTransport = transport
			defer func() { transport.CloseIdleConnections(); ippDirectTransport = previous }()
			pc := config.PrinterConfig{ID: "actual-ipp", Name: "Observed IPP", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://10.0.0.20:631/ipp/print"}
			backend, err := New(pc)
			if err != nil {
				t.Fatal(err)
			}
			proof, err := ProbeOperationalVerification(context.Background(), backend, pc)
			if (err == nil) != (mode == "valid") {
				t.Fatalf("actual attributes mode=%s proof=%+v err=%v", mode, proof, err)
			}
			if probes.Load() != 1 || submissions.Load() != 0 {
				t.Fatalf("probe performed output or did not query actual service: probes=%d submissions=%d", probes.Load(), submissions.Load())
			}
			if proof != nil && (proof.IdentityStrength != "service" || proof.PhysicalDeviceKey != "" || proof.OutputMedium != "physical") {
				t.Fatalf("IPP service was mislabeled as physical identity: %+v", proof)
			}
		})
	}
}
