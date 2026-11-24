package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

type physicalTestDispatch struct{ submitted, probed bool }

func (p *physicalTestDispatch) Print(context.Context, []byte) error { return nil }
func (p *physicalTestDispatch) Test(context.Context) error          { p.probed = true; return nil }
func (p *physicalTestDispatch) Status() string                      { return "unknown" }
func (p *physicalTestDispatch) PrintTestPage(context.Context) error { p.submitted = true; return nil }

func TestLocalPrintActionUsesSubmissionRatherThanReadinessProbe(t *testing.T) {
	p := &physicalTestDispatch{}
	if err := runLocalPrinterTest(context.Background(), p); err != nil || !p.submitted || p.probed {
		t.Fatalf("local print action only probed readiness: %+v %v", p, err)
	}
}

func TestLocalPrintSelectionPrefersExactIDAcrossRegistryAndConfig(t *testing.T) {
	registry := []DeviceInfo{{ID: "other", Name: "selected-id", SpoolerName: "Other Queue"}}
	configured := []DeviceInfo{{ID: "selected-id", Name: "Actual Printer", SpoolerName: "Selected Queue"}}
	selected, err := selectLocalTestTarget(registry, configured, "selected-id")
	if err != nil || selected == nil || selected.ID != "selected-id" || selected.SpoolerName != "Selected Queue" {
		t.Fatalf("name collision selected another printer: %#v %v", selected, err)
	}
	registry = append(registry, DeviceInfo{ID: "selected-id", SpoolerName: "Registered Queue"})
	selected, err = selectLocalTestTarget(registry, configured, "selected-id")
	if err != nil || selected == nil || selected.SpoolerName != "Registered Queue" {
		t.Fatalf("exact registry precedence changed: %#v %v", selected, err)
	}
}

func TestLocalPrintSelectionRejectsAmbiguousAliasesAndPreservesUniquePrecedence(t *testing.T) {
	registry := []DeviceInfo{{ID: "first", Name: "Same Name"}, {ID: "second", Name: "Same Name"}}
	if selected, err := selectLocalTestTarget(registry, nil, "Same Name"); err == nil || selected != nil {
		t.Fatalf("ambiguous alias silently selected a printer: %#v %v", selected, err)
	}
	registry = registry[:1]
	selected, err := selectLocalTestTarget(registry, []DeviceInfo{{ID: "first", Name: "Same Name"}}, "Same Name")
	if err != nil || selected == nil || selected.ID != "first" {
		t.Fatalf("same identity across registry and config became ambiguous: %#v %v", selected, err)
	}
	if selected, err := selectLocalTestTarget([]DeviceInfo{{Name: "Pathless"}}, nil, ""); err == nil || selected != nil {
		t.Fatalf("empty selection chose an unrelated printer: %#v %v", selected, err)
	}
}

func TestBoundedDiagnosticMediaLimitsLongRollAndPreservesSheets(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		width, height, expectedHeight float64
	}{
		{"POS80 10-metre driver form", 640 * 72.0 / 203, 26200 * 72.0 / 203, 100 * 72 / 25.4},
		{"72.1mm selected roll", 72.1 * 72 / 25.4, 600 * 72 / 25.4, 100 * 72 / 25.4},
		{"58mm short stock", 58 * 72 / 25.4, 120 * 72 / 25.4, 120 * 72 / 25.4},
		{"A4 sheet", 595.28, 841.89, 841.89},
		{"Letter sheet", 612, 792, 792},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, h, err := boundedDiagnosticPaper(tc.width, tc.height)
			if err != nil || math.Abs(w-tc.width) > .01 || math.Abs(h-tc.expectedHeight) > .01 {
				t.Fatalf("selected driver media: %g x %g, expected %g x %g: %v", w, h, tc.width, tc.expectedHeight, err)
			}
		})
	}
	for _, bad := range [][2]float64{{0, 792}, {math.NaN(), 792}, {72, math.Inf(1)}, {612, 100000}} {
		if _, _, err := boundedDiagnosticPaper(bad[0], bad[1]); err == nil {
			t.Fatalf("invalid native paper admitted: %v", bad)
		}
	}
}

func TestDiagnosticPDFHasActualSelectedMediaAndValidObjectOffsets(t *testing.T) {
	for _, size := range [][2]float64{{612, 792}, {58 * 72 / 25.4, 100 * 72 / 25.4}, {72.1 * 72 / 25.4, 100.1 * 72 / 25.4}} {
		pdf, err := diagnosticTestPDF(size[0], size[1])
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidatePDF(pdf); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(pdf, []byte(fmt.Sprintf("/MediaBox [0 0 %.2f %.2f]", size[0], size[1]))) || !bytes.Contains(pdf, []byte("YASEIR PRINT TEST")) {
			t.Fatalf("diagnostic lost selected paper or content: %q", pdf)
		}
		for i := 1; i <= 5; i++ {
			offset := bytes.Index(pdf, []byte(fmt.Sprintf("%d 0 obj\n", i)))
			if offset < 0 || !bytes.Contains(pdf, []byte(fmt.Sprintf("%010d 00000 n", offset))) {
				t.Fatalf("object%d has no correct xref offset", i)
			}
		}
	}
}

func TestLocalByteDiagnosticsUseDeclaredLanguageWithoutMediaOrPeripheralGuesses(t *testing.T) {
	for _, protocol := range []string{"raw", "escpos", "zpl", "tspl"} {
		data, err := localByteDiagnosticPayload(" " + strings.ToUpper(protocol) + " ")
		if err != nil || len(data) == 0 {
			t.Fatalf("supported%s has no diagnostic: %q %v", protocol, data, err)
		}
		if bytes.Contains(data, []byte("\x1dV")) || bytes.Contains(data, []byte("SIZE ")) || bytes.Contains(data, []byte("GAP ")) || bytes.Contains(data, []byte("^GB700")) {
			t.Fatalf("%s diagnostic guesses stock/peripheral: %q", protocol, data)
		}
		if protocol == "tspl" && string(data) != "SELFTEST\r\n" {
			t.Fatalf("TSPL is not native SELFTEST: %q", data)
		}
		if protocol == "zpl" && string(data) != "^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n" {
			t.Fatalf("ZPL is not compact buffered diagnostic: %q", data)
		}
		if protocol == "raw" && bytes.ContainsAny(data, "\x1b\x1d") {
			t.Fatalf("raw diagnostic guessed ESC/POS: %q", data)
		}
	}
	for _, protocol := range []string{"", "unknown", "ipp", "pdf", "spooler"} {
		if data, err := localByteDiagnosticPayload(protocol); !IsCapabilityMismatch(err) || len(data) != 0 {
			t.Fatalf("undeclared byte language manufactured: %q %q %v", protocol, data, err)
		}
	}
}

func TestNetworkDiagnosticSendsMatchedBytesForEveryImplementedByteLanguage(t *testing.T) {
	for _, protocol := range []string{"raw", "escpos", "zpl", "tspl"} {
		t.Run(protocol, func(t *testing.T) {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			received := make(chan []byte, 1)
			go func() {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				data, _ := io.ReadAll(conn)
				received <- data
			}()
			p := &NetworkPrinter{Address: ln.Addr().String(), Protocol: protocol}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := p.Test(ctx); err != nil {
				t.Fatalf("%s test did not submit: %v", protocol, err)
			}
			want, _ := localByteDiagnosticPayload(protocol)
			select {
			case got := <-received:
				if !bytes.Equal(got, want) {
					t.Fatalf("%s wrote %q want %q", protocol, got, want)
				}
			case <-ctx.Done():
				t.Fatal("no diagnostic received")
			}
		})
	}
}

func TestIPPLocalDiagnosticNegotiatesAndSubmitsOneRealPDF(t *testing.T) {
	for _, mm := range []int{0, 58, 80} {
		t.Run(fmt.Sprint(mm), func(t *testing.T) {
			var submitted atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data, _ := io.ReadAll(r.Body)
				w.Header().Set("Content-Type", "application/ipp")
				if len(data) < 8 {
					t.Error("truncated IPP request")
					w.WriteHeader(400)
					return
				}
				if binary.BigEndian.Uint16(data[2:4]) == 0x000b {
					attrs := bytes.NewBuffer(ippNoMediaFixture())
					attrs.Truncate(attrs.Len() - 1)
					media := "na_letter_8.5x11in"
					if mm > 0 {
						media = fmt.Sprintf("custom_receipt_%dx100mm", mm)
					}
					writeIPPAttribute(attrs, 0x44, "media-default", media)
					attrs.WriteByte(3)
					_, _ = w.Write(attrs.Bytes())
					return
				}
				submitted.Add(1)
				if !bytes.Contains(data, []byte("%PDF-1.4")) || !bytes.Contains(data, []byte("YASEIR PRINT TEST")) {
					t.Error("IPP test did not contain a real diagnostic PDF")
				}
				if mm > 0 && !bytes.Contains(data, []byte(fmt.Sprintf("/MediaBox [0 0 %.2f %.2f]", float64(mm)*72/25.4, 100*72/25.4))) {
					t.Error("IPP diagnostic ignored selected receipt width")
				}
				_, _ = w.Write(ippAcceptedJobResponse(0, 3))
			}))
			defer server.Close()
			p, err := NewIPPPrinter(server.URL, "diagnostic")
			if err != nil {
				t.Fatal(err)
			}
			p.testPaperMM = mm
			if err := runLocalPrinterTest(context.Background(), p); err != nil || submitted.Load() != 1 {
				t.Fatalf("IPP diagnostic result=%v submissions=%d", err, submitted.Load())
			}
		})
	}
}

func TestConfiguredIPPDiagnosticsPreserveSelectedReceiptWidth(t *testing.T) {
	for _, transport := range []string{"network", "ipp", "ipps"} {
		protocol, endpoint := "ipp", "ipp://192.168.1.20/ipp/print"
		if transport == "ipps" {
			protocol, endpoint = "ipps", "ipps://192.168.1.20/ipp/print"
		}
		p, err := New(config.PrinterConfig{ID: "test", Type: transport, Protocol: protocol, Endpoint: endpoint, PaperWidthMM: 58, Capabilities: map[string]interface{}{"paper_width_mm": 80}})
		if err != nil {
			t.Fatal(err)
		}
		ipp, ok := p.(*IPPPrinter)
		if !ok || ipp.testPaperMM != 58 {
			t.Fatalf("%s lost selected diagnostic paper: %#v", transport, p)
		}
	}
}

func TestIPPLocalDiagnosticCannotBypassCapabilityFailure(t *testing.T) {
	var submissions atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if len(data) >= 8 && binary.BigEndian.Uint16(data[2:4]) != 0x000b {
			submissions.Add(1)
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "refused diagnostic")
	if err != nil {
		t.Fatal(err)
	}
	err = p.Test(context.Background())
	if err == nil || OutcomeUnknown(err) || submissions.Load() != 0 {
		t.Fatalf("IPP local test bypassed capability admission: err=%v submissions=%d", err, submissions.Load())
	}
}
