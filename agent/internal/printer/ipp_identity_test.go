package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

const ippIdentityFixtureUUID = "urn:uuid:748a4a60-2bfd-4f21-9e75-937e7eeedc79"

func ippIdentityFixture(uuid string) []byte {
	b := bytes.NewBuffer(ippAttrResponse(ippFormatPDF))
	b.Truncate(b.Len() - 1)
	if uuid != "" {
		writeIPPAttribute(b, 0x45, "printer-uuid", uuid)
	}
	b.WriteByte(3)
	return b.Bytes()
}

func TestIPPPreviouslyObservedIdentityCannotSilentlyChangeOrDisappear(t *testing.T) {
	for _, replacement := range []string{"urn:uuid:7d0f846c-90ab-4d2c-87c1-63d21082ff68", ""} {
		var phase, submitted atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := readAll(r.Body)
			w.Header().Set("Content-Type", "application/ipp")
			if len(body) >= 8 && binary.BigEndian.Uint16(body[2:4]) == 0x000b {
				uuid := ippIdentityFixtureUUID
				if phase.Load() != 0 {
					uuid = replacement
				}
				_, _ = w.Write(ippIdentityFixture(uuid))
				return
			}
			submitted.Add(1)
			_, _ = w.Write(ippAcceptedJobResponse(0, 3))
		}))
		p, err := NewIPPPrinter(server.URL, "identity change fixture")
		if err != nil {
			t.Fatal(err)
		}
		if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()}); err != nil {
			server.Close()
			t.Fatal(err)
		}
		phase.Store(1)
		err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
		server.Close()
		if err == nil || OutcomeUnknown(err) || !strings.Contains(err.Error(), "identity") || submitted.Load() != 1 {
			t.Fatalf("replacement received document or unknown state: replacement%q count%d error%v", replacement, submitted.Load(), err)
		}
	}
}

func TestIPPPersistedIdentityIsCheckedOnFirstProbe(t *testing.T) {
	var submitted atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(body) >= 8 && binary.BigEndian.Uint16(body[2:4]) == 0x000b {
			_, _ = w.Write(ippIdentityFixture("urn:uuid:7d0f846c-90ab-4d2c-87c1-63d21082ff68"))
			return
		}
		submitted.Add(1)
		_, _ = w.Write(ippAcceptedJobResponse(0, 3))
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "persisted identity")
	if err != nil {
		t.Fatal(err)
	}
	p.geometryConfig = config.PrinterConfig{Capabilities: map[string]interface{}{"ipp_printer_uuid": ippIdentityFixtureUUID}}
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
	if err == nil || OutcomeUnknown(err) || submitted.Load() != 0 {
		t.Fatalf("restarted backend rebound to new hardware: %v count%d", err, submitted.Load())
	}
}

func TestIPPPrinterUUIDRequiresTypedCanonicalIdentity(t *testing.T) {
	if !bytes.Contains(buildIPPGetPrinterAttributes("ipp://printer.local/ipp/print"), []byte("printer-uuid")) {
		t.Fatal("live UUID not requested")
	}
	for _, value := range []string{"not-a-uuid", "urn:uuid:00000000-0000-0000-0000-000000000000", "http://printer.local/id", ippIdentityFixtureUUID + "\n"} {
		if _, err := parseIPPPrinterAttributes(ippIdentityFixture(value), 1); err == nil {
			t.Fatalf("accepted invalid identity %q", value)
		}
	}
	attrs, err := parseIPPPrinterAttributes(ippIdentityFixture(strings.ToUpper(ippIdentityFixtureUUID)), 1)
	if err != nil || attrs["printer-uuid"] != ippIdentityFixtureUUID {
		t.Fatalf("valid identity not canonicalized: %+v %v", attrs, err)
	}
	wrong := bytes.Replace(ippIdentityFixture(ippIdentityFixtureUUID), []byte{0x45, 0, 12}, []byte{0x44, 0, 12}, 1)
	if _, err := parseIPPPrinterAttributes(wrong, 1); err == nil {
		t.Fatal("wrong UUID value tag authorized identity")
	}
	p := &IPPPrinter{geometryConfig: config.PrinterConfig{Capabilities: map[string]interface{}{"ipp_printer_uuid": "corrupt"}}}
	if err := p.checkIPPIdentity(attrs); err == nil {
		t.Fatal("corrupt persisted identity silently rebound")
	}
}

func TestIPPGeometryFingerprintIncludesPrinterServiceUUID(t *testing.T) {
	attrs, err := parseIPPPrinterAttributes(ippMeasuredMediaFixture(), 1)
	if err != nil {
		t.Fatal(err)
	}
	attrs["printer-resolution-supported"] = "300x300dpi"
	attrs["printer-uuid"] = ippIdentityFixtureUUID
	cfg := config.PrinterConfig{ID: "ipp-identity-geometry", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.20/ipp/print"}
	first, err := ippGeometryFromAttributes(cfg, attrs)
	if err != nil {
		t.Fatal(err)
	}
	attrs["printer-uuid"] = "urn:uuid:7d0f846c-90ab-4d2c-87c1-63d21082ff68"
	other, err := ippGeometryFromAttributes(cfg, attrs)
	if err != nil || first.ConfigFingerprint == other.ConfigFingerprint {
		t.Fatalf("identical media hid different service identity: %v", err)
	}
}
