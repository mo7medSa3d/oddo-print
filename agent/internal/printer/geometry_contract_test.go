package printer

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

// The Gateway's isExactPrinterId rejects IDs beyond 120 UTF-8 bytes and
// JavaScript edge-trim BOM. Geometry must not assert a fingerprint for a
// destination that heartbeat inventory and print-job routing cannot name.
func TestGeometryPrinterIDMatchesGatewayOpaqueUTF8Contract(t *testing.T) {
	for _, tc := range []struct {
		name, id string
		accepted bool
	}{
		{"120 ASCII bytes", strings.Repeat("p", 120), true},
		{"121 ASCII bytes", strings.Repeat("p", 121), false},
		{"60 Arabic letters", strings.Repeat("ط", 60), true},
		{"61 Arabic letters", strings.Repeat("ط", 61), false},
		{"30 emoji", strings.Repeat("😀", 30), true},
		{"31 emoji", strings.Repeat("😀", 31), false},
		{"leading BOM", "\uFEFFprinter", false},
		{"trailing BOM", "printer\uFEFF", false},
		{"interior BOM", "prin\uFEFFter", true},
		{"invalid UTF-8", string([]byte{0xff}), false},
		{"newline", "printer\nother", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validGeometryPrinterID(tc.id); got != tc.accepted {
				t.Fatalf("geometry accepted=%v, Gateway contract=%v for ID %q (%d bytes)", got, tc.accepted, tc.id, len(tc.id))
			}
			cfg := config.PrinterConfig{ID: tc.id, Type: "network", Protocol: "escpos", Endpoint: "192.168.1.20:9100"}
			_, err := NewGeometry(cfg, config.GeometryProfile{PrintableWidthDots: 512}, "validated_profile", "configured", "operator_profile")
			if (err == nil) != tc.accepted {
				t.Fatalf("geometry creation differs from Gateway identity authority: accepted=%v, err=%v", tc.accepted, err)
			}
		})
	}
}

func TestGeometrySharedContractFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/printer-geometry-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		GeometryCases []struct {
			Name            string
			Geometry        interface{}
			Valid, Physical bool
			RasterWidth     int
			Expected        struct {
				PrinterID   string `json:"printerId"`
				Fingerprint string
			}
		}
		ProfileCases []struct {
			Name    string
			Profile interface{}
			Valid   bool
		}
		PayloadCases []struct {
			Name    string
			Printer struct {
				ID, ConnectionType, Protocol string
				Capabilities                 map[string]interface{}
			}
			Payload struct {
				Type, Protocol      string
				GeometryFingerprint string `json:"geometry_fingerprint"`
			}
			Allowed bool
		}
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, tc := range fixtures.GeometryCases {
		t.Run(tc.Name, func(t *testing.T) {
			g, err := ParseGeometry(tc.Geometry, tc.Expected.PrinterID, tc.Expected.Fingerprint)
			if (err == nil) != tc.Valid {
				t.Fatalf("valid=%v want=%v: %v", err == nil, tc.Valid, err)
			}
			if tc.Valid {
				if g.PhysicalImageReady() != tc.Physical {
					t.Fatalf("physical geometry mismatch")
				}
				width := g.PrintableWidthDots
				if width != tc.RasterWidth {
					t.Fatalf("raster width=%d want=%d", width, tc.RasterWidth)
				}
			}
		})
	}
	for _, tc := range fixtures.ProfileCases {
		t.Run("profile/"+tc.Name, func(t *testing.T) {
			_, err := ParseGeometryProfile(tc.Profile)
			if (err == nil) != tc.Valid {
				t.Fatalf("valid=%v want=%v: %v", err == nil, tc.Valid, err)
			}
		})
	}
	for _, tc := range fixtures.PayloadCases {
		t.Run("payload/"+tc.Name, func(t *testing.T) {
			g, _ := ParseGeometry(tc.Printer.Capabilities["geometry"], tc.Printer.ID, "")
			facts := TransportFacts{Connection: tc.Printer.ConnectionType, Protocol: tc.Printer.Protocol, Geometry: g}
			if raw, present := tc.Printer.Capabilities["supported_protocols"]; present {
				facts.SupportedProtocolDeclared = true
				if values, ok := raw.([]interface{}); ok {
					for _, v := range values {
						if text, ok := v.(string); ok {
							facts.SupportedProtocol = append(facts.SupportedProtocol, text)
						}
					}
				}
			}
			allowed, _ := PayloadCompatibleForDevice(tc.Payload.Type, tc.Payload.Protocol, facts)
			if tc.Payload.Type == KindImage && g.CheckImageFingerprint(tc.Payload.GeometryFingerprint) != nil {
				allowed = false
			}
			if allowed != tc.Allowed {
				t.Fatalf("allowed=%v want=%v", allowed, tc.Allowed)
			}
		})
	}
}

func TestGeometryFingerprintBindsDestinationMediaAndResolution(t *testing.T) {
	dpi, mm := 203, 80.0
	profile := config.GeometryProfile{PrintableWidthDots: 576, DPIX: &dpi, DPIY: &dpi, PaperWidthMM: &mm, RasterCommand: "gs_v_0"}
	cfg := config.PrinterConfig{ID: "receipt", Type: "network", Protocol: "escpos", Endpoint: "192.168.1.50:9100", GeometryProfile: &profile}
	first, err := ConfiguredGeometry(cfg)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ConfiguredGeometry(cfg)
	if err != nil || first.ConfigFingerprint != second.ConfigFingerprint {
		t.Fatalf("time changed fingerprint: %v", err)
	}
	for _, change := range []func(*config.PrinterConfig){
		func(c *config.PrinterConfig) { c.Endpoint = "192.168.1.51:9100" },
		func(c *config.PrinterConfig) { c.Protocol = "raw" },
		func(c *config.PrinterConfig) {
			p := *c.GeometryProfile
			p.PrintableWidthDots = 552
			c.GeometryProfile = &p
		},
		func(c *config.PrinterConfig) {
			p := *c.GeometryProfile
			d := 300
			p.DPIX = &d
			p.DPIY = &d
			c.GeometryProfile = &p
		},
	} {
		changed := cfg
		change(&changed)
		g, err := ConfiguredGeometry(changed)
		if err != nil || g.ConfigFingerprint == first.ConfigFingerprint {
			t.Fatalf("configuration change not fenced: %v", err)
		}
		if err := g.CheckImageFingerprint(first.ConfigFingerprint); err == nil {
			t.Fatal("stale image admitted")
		}
	}
}

func TestGeometryLegacyObservationCannotBecomeConfiguredProfile(t *testing.T) {
	cfg := config.PrinterConfig{ID: "legacy", Type: "network", Protocol: "escpos", Endpoint: "192.168.1.50:9100", PaperWidthMM: 80,
		Capabilities: map[string]interface{}{"max_paper_width": 512, "print_dpi": 180, "raster_command": "gs_v_0"}}
	if g, err := ConfiguredGeometry(cfg); err == nil || g != nil {
		t.Fatal("old observed 80mm/512 hint gained configured provenance")
	}
	cfg.ExplicitLegacyGeometry = true
	g, err := ConfiguredGeometry(cfg)
	if err != nil || g.Source != "validated_profile" || g.Validation != "configured" || g.PrintableWidthDots != 512 {
		t.Fatalf("explicit legacy operator profile was lost: %+v %v", g, err)
	}
	cfg.Capabilities["max_paper_width"] = 80
	if g, err := ConfiguredGeometry(cfg); err == nil || g != nil {
		t.Fatal("legacy millimetres were interpreted as head dots")
	}
}

func TestGeometryUSBAndTCPPreparationRejectBeforeTransport(t *testing.T) {
	g := testRasterGeometry(576)
	valid := Document{Kind: KindImage, Data: createTestJPEG(576, 600), GeometryFingerprint: g.ConfigFingerprint}
	output, err := prepareESCPOSImage("escpos", g, valid)
	if err != nil || rasterWidthFromESCPOS(output) != 72 {
		t.Fatalf("USB/TCP preparation failed: %v", err)
	}
	for _, change := range []func(*Document, *Geometry){
		func(d *Document, g *Geometry) { d.GeometryFingerprint = "" },
		func(d *Document, g *Geometry) { d.GeometryFingerprint = strings.Repeat("b", 64) },
		func(d *Document, g *Geometry) { d.Data = []byte("broken jpeg") },
		func(d *Document, g *Geometry) { d.Data = createTestJPEG(577, 1) },
		func(d *Document, g *Geometry) { g.RasterCommand = "" },
	} {
		doc, geometry := valid, *g
		change(&doc, &geometry)
		if data, err := prepareESCPOSImage("escpos", &geometry, doc); err == nil || len(data) != 0 {
			t.Fatal("invalid raster produced transport bytes")
		}
		// An invalid endpoint would produce a dial error if preparation leaked.
		p := &NetworkPrinter{Address: "invalid-address", Protocol: "escpos", Geometry: &geometry}
		if err := p.PrintDocument(context.Background(), doc); err == nil || strings.Contains(err.Error(), "dial ") {
			t.Fatalf("invalid image reached TCP dial: %v", err)
		}
	}
	for _, protocol := range []string{"raw", "zpl", "tspl", "unknown"} {
		if _, err := prepareESCPOSImage(protocol, g, valid); err == nil {
			t.Fatalf("unsupported raster protocol %q", protocol)
		}
	}
}

func TestImageGeometryUsesIndependentDPIWithoutHeightShrink(t *testing.T) {
	for _, axes := range [][2]int{{203, 203}, {300, 300}, {600, 600}, {600, 300}} {
		width := int(math.Round(72 * float64(axes[0]) / 25.4))
		g := testRasterGeometry(width)
		mm := 80.0
		g.PaperWidthMM = &mm
		g.DPIX = &axes[0]
		g.DPIY = &axes[1]
		data, err := JPEGToPDFGeometry(createTestJPEG(width, 2400), g)
		if err != nil {
			t.Fatal(err)
		}
		_, _, imageW, imageH, _, _ := pdfImageGeometry(t, data)
		if math.Abs(imageW*float64(axes[0])/72-float64(width)) > .001 || math.Abs(imageH*float64(axes[1])/72-2400) > .001 {
			t.Fatalf("DPI %v changed physical image scale", axes)
		}
	}
}

func TestGeometryMeasuredDeviceSupportsRollCustomAndOfficeForms(t *testing.T) {
	for _, mm := range []float64{58, 80, 75, 148, 210} {
		for _, dpi := range []int{203, 300, 600} {
			physicalW := int(math.Round(mm * float64(dpi) / 25.4))
			physicalH := int(math.Round(297 * float64(dpi) / 25.4))
			p, err := deviceGeometryProfile(physicalW, physicalH, physicalW-20, physicalH-20, dpi, dpi, 10, 10)
			if err != nil || p.PrintableWidthDots != physicalW-20 || *p.DPIX != dpi {
				t.Fatalf("form %.0fmm at %dDPI rejected: %v", mm, dpi, err)
			}
		}
	}
	for _, caps := range [][8]int{{640, 4000, 576, 3976, 0, 203, 32, 12}, {640, 4000, 650, 3976, 203, 203, 32, 12}, {640, 4000, 576, 3976, 203, 203, -1, 12}} {
		if _, err := deviceGeometryProfile(caps[0], caps[1], caps[2], caps[3], caps[4], caps[5], caps[6], caps[7]); err == nil {
			t.Fatalf("malformed driver geometry accepted: %v", caps)
		}
	}
}
