package payload

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseValidRaw(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("hello printer"))
	pl, err := Parse(map[string]interface{}{
		"type":     "raw",
		"protocol": "raw",
		"encoding": "base64",
		"data":     data,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Type != TypeRaw || pl.Protocol != "raw" || string(pl.Data) != "hello printer" {
		t.Fatalf("unexpected payload: %+v", pl)
	}
}

func TestParseValidEscpos(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("\x1b\x40test\x1d\x56\x01"))
	pl, err := Parse(map[string]interface{}{
		"type":     "escpos",
		"protocol": "escpos",
		"encoding": "base64",
		"data":     data,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Type != TypeESCPOS || pl.Protocol != "escpos" {
		t.Fatalf("expected escpos with escpos protocol, got %s / %s", pl.Type, pl.Protocol)
	}
}

func TestParseValidPDF(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))
	pl, err := Parse(map[string]interface{}{"type": "pdf", "encoding": "base64", "data": data})
	if err != nil {
		t.Fatalf("unexpected error for pdf: %v", err)
	}
	if pl.Type != TypePDF {
		t.Fatalf("expected pdf, got %s", pl.Type)
	}
}

func TestPDFSignaturePolicyMatchesGateway(t *testing.T) {
	prefixed := base64.StdEncoding.EncodeToString([]byte("\n%PDF-1.4 fake"))
	if _, err := Parse(map[string]interface{}{"type": "pdf", "encoding": "base64", "data": prefixed}); err == nil {
		t.Fatal("PDF signature after a prefix must be rejected")
	}
	rawWithMarker := base64.StdEncoding.EncodeToString([]byte("label %PDF- text"))
	if _, err := Parse(map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": rawWithMarker}); err != nil {
		t.Fatalf("RAW marker text after byte zero must remain valid: %v", err)
	}
}

func TestParseInvalidCases(t *testing.T) {
	validData := base64.StdEncoding.EncodeToString([]byte("hello"))
	cases := []struct {
		name string
		raw  interface{}
	}{
		{"nil", nil},
		{"not object", "string"},
		{"missing type", map[string]interface{}{"encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("x"))}},
		{"bad type", map[string]interface{}{"type": "badtype", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("x"))}},
		{"raw missing protocol", map[string]interface{}{"type": "raw", "encoding": "base64", "data": validData}},
		{"raw unsupported protocol", map[string]interface{}{"type": "raw", "protocol": "unknown", "encoding": "base64", "data": validData}},
		{"escpos missing protocol", map[string]interface{}{"type": "escpos", "encoding": "base64", "data": validData}},
		{"escpos incompatible protocol", map[string]interface{}{"type": "escpos", "protocol": "zpl", "encoding": "base64", "data": validData}},
		{"pdf with protocol", map[string]interface{}{"type": "pdf", "protocol": "escpos", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake"))}},
		{"bad encoding", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "hex", "data": validData}},
		{"missing data", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64"}},
		{"empty data", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": ""}},
		{"invalid base64", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": "!!! not base64"}},
		{"empty decoded", map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": base64.StdEncoding.EncodeToString([]byte(""))}},
		{"peripherals with non-escpos", map[string]interface{}{
			"type":     "raw",
			"protocol": "zpl",
			"encoding": "base64",
			"data":     validData,
			"peripherals": map[string]interface{}{
				"cutter": "full",
			},
		}},
	}
	for _, c := range cases {
		_, err := Parse(c.raw)
		if err == nil {
			t.Errorf("case %q expected error, got nil", c.name)
		}
	}
}

func TestParseOversizedPrecheck(t *testing.T) {
	// craft a base64 string that would decode to >5MiB
	huge := strings.Repeat("A", (MaxPayloadBytes/3)*4+20)
	_, err := Parse(map[string]interface{}{"type": "raw", "protocol": "raw", "encoding": "base64", "data": huge})
	if err == nil {
		t.Fatalf("expected oversized error")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected too large, got %v", err)
	}
}

func TestParsePeripherals(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("hello"))
	pl, err := Parse(map[string]interface{}{
		"type":     "raw",
		"protocol": "escpos",
		"encoding": "base64",
		"data":     data,
		"peripherals": map[string]interface{}{
			"drawer": "pin2",
			"cutter": "full",
			"buzzer": "epson_pulse",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pl.Peripherals.Drawer != "pin2" || pl.Peripherals.Cutter != "full" || pl.Peripherals.Buzzer != "epson_pulse" {
		t.Fatalf("unexpected peripherals: %+v", pl.Peripherals)
	}
}


func TestGatewayPayloadContractIsTheAgentContract(t *testing.T) {
	type contract struct {
		Encoding        string `json:"encoding"`
		MaxPayloadBytes int    `json:"maxPayloadBytes"`
		WireTypes       []string `json:"wireTypes"`
		RawProtocols    []string `json:"rawProtocols"`
		EscposProtocol  string `json:"escposProtocol"`
		Peripherals     struct {
			Drawer []string `json:"drawer"`
			Cutter []string `json:"cutter"`
			Buzzer []string `json:"buzzer"`
		} `json:"peripherals"`
		Signatures struct {
			PDFPrefix     string `json:"pdfPrefix"`
			JPEGHexPrefix string `json:"jpegHexPrefix"`
		} `json:"signatures"`
	}
	path := filepath.Join("..", "..", "..", "contracts", "print-payload-contract.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Gateway payload contract %s: %v", path, err)
	}
	var ctn contract
	if err := json.Unmarshal(data, &ctn); err != nil {
		t.Fatalf("decode Gateway payload contract: %v", err)
	}

	if ctn.Encoding != EncodingBase64 {
		t.Fatalf("encoding = %q, want %q", ctn.Encoding, EncodingBase64)
	}
	if ctn.MaxPayloadBytes != MaxPayloadBytes {
		t.Fatalf("MaxPayloadBytes = %d, want %d", ctn.MaxPayloadBytes, MaxPayloadBytes)
	}
	wantTypes := []Type{TypeRaw, TypeESCPOS, TypePDF, TypeImage}
	if len(ctn.WireTypes) != len(wantTypes) {
		t.Fatalf("wireTypes length = %d, want %d", len(ctn.WireTypes), len(wantTypes))
	}
	for i, want := range wantTypes {
		if ctn.WireTypes[i] != string(want) {
			t.Fatalf("wireTypes[%d] = %q, want %q", i, ctn.WireTypes[i], want)
		}
	}

	wantRaw := []string{"raw", "escpos", "zpl", "tspl"}
	if strings.Join(ctn.RawProtocols, ",") != strings.Join(wantRaw, ",") {
		t.Fatalf("rawProtocols = %#v, want %#v", ctn.RawProtocols, wantRaw)
	}
	if ctn.EscposProtocol != "escpos" {
		t.Fatalf("escposProtocol = %q, want escpos", ctn.EscposProtocol)
	}
	if strings.Join(ctn.Peripherals.Drawer, ",") != "pin2,pin5,none" {
		t.Fatalf("drawer contract = %#v", ctn.Peripherals.Drawer)
	}
	if strings.Join(ctn.Peripherals.Cutter, ",") != "partial,full,none" {
		t.Fatalf("cutter contract = %#v", ctn.Peripherals.Cutter)
	}
	if strings.Join(ctn.Peripherals.Buzzer, ",") != "epson_pulse,star_bel,none" {
		t.Fatalf("buzzer contract = %#v", ctn.Peripherals.Buzzer)
	}
	if ctn.Signatures.PDFPrefix != "%PDF-" || ctn.Signatures.JPEGHexPrefix != "ffd8ff" {
		t.Fatalf("signature contract = %+v", ctn.Signatures)
	}

	validRawProtocols := map[string]bool{}
	for _, v := range ctn.RawProtocols {
		validRawProtocols[v] = true
	}
	for protocol := range validRawProtocols {
		raw := map[string]interface{}{
			"type": "raw", "protocol": protocol, "encoding": EncodingBase64,
			"data": base64.StdEncoding.EncodeToString([]byte("contract")),
		}
		if _, err := Parse(raw); err != nil {
			t.Fatalf("contract raw protocol %q rejected: %v", protocol, err)
		}
	}
	for _, drawer := range ctn.Peripherals.Drawer {
		if drawer == "none" {
			continue
		}
		raw := map[string]interface{}{
			"type": "escpos", "protocol": "escpos", "encoding": EncodingBase64,
			"data": base64.StdEncoding.EncodeToString([]byte("contract")),
			"peripherals": map[string]interface{}{"drawer": drawer},
		}
		if _, err := Parse(raw); err != nil {
			t.Fatalf("contract drawer %q rejected: %v", drawer, err)
		}
	}
}
