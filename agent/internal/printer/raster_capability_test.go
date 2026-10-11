package printer

import (
	"bytes"
	"testing"
)

func rasterWidthFromESCPOS(data []byte) int {
	marker := []byte{0x1d, 0x76, 0x30, 0x00}
	idx := bytes.Index(data, marker)
	if idx < 0 || idx+6 >= len(data) {
		return 0
	}
	lo, hi := data[idx+4], data[idx+5]
	return int(lo) | int(hi)<<8
}

func TestRasterMaxWidthFromDesiredPaperWidth(t *testing.T) {
	if got := RasterMaxWidthFromPaperWidthMM(80); got != 512 {
		t.Fatalf("80mm unknown-DPI paper: got %d dots, want conservative 512", got)
	}
}

func TestRasterWidthHonorsReal80mmResolutionAndOperatorDots(t *testing.T) {
	for _, test := range []struct {
		caps map[string]interface{}
		want int
	}{
		{map[string]interface{}{"print_dpi": 180}, 512},
		{map[string]interface{}{"print_dpi": 203}, 576},
		{map[string]interface{}{"print_dpi": 180, "max_paper_width": 512}, 512},
		{map[string]interface{}{"print_dpi": 203, "max_paper_width": 512}, 512},
		{map[string]interface{}{"max_paper_width": 576}, 576},
		{nil, 512},
	} {
		if got := RasterMaxWidthForConfiguredPaper(80, test.caps); got != test.want {
			t.Errorf("80mm dimensions: caps=%v got=%d want=%d", test.caps, got, test.want)
		}
	}
	if got := RasterMaxWidthForConfiguredPaper(58, map[string]interface{}{"max_paper_width": 420, "print_dpi": 203}); got != 420 {
		t.Fatalf("58mm Epson-style 420-dot printable area was truncated: %d", got)
	}
}

func TestRasterMaxWidthFromCapabilities(t *testing.T) {
	cases := []struct {
		name string
		caps map[string]interface{}
		want int
	}{
		{"unknown", nil, SafeRasterMaxWidth},
		{"explicit 58mm", map[string]interface{}{"max_paper_width": 58}, 384},
		{"explicit 576 dots", map[string]interface{}{"max_paper_width": 576}, 576},
		{"legacy narrow set", map[string]interface{}{"paper_widths": []int{58, 80}}, 384},
		{"json numbers", map[string]interface{}{"paper_widths": []interface{}{80.0}}, 512},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RasterMaxWidthFromCapabilities(tc.caps); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestRasterMaxWidthClampedToHardware(t *testing.T) {
	// An absurd capability (unit typo, hostile value) must never become an
	// execution raster width the 576-dot thermal path cannot take.
	cases := []struct {
		name string
		caps map[string]interface{}
	}{
		{"huge dot width", map[string]interface{}{"max_paper_width": 5000}},
		{"huge paper widths", map[string]interface{}{"paper_widths": []int{500}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RasterMaxWidthFromCapabilities(tc.caps); got > maxRasterWidth {
				t.Fatalf("got %d dots, exceeds hardware ceiling %d", got, maxRasterWidth)
			}
		})
	}
	if got := RasterMaxWidthFromPaperWidthMM(200); got > maxRasterWidth {
		t.Fatalf("200mm paper: got %d dots, exceeds hardware ceiling %d", got, maxRasterWidth)
	}
}

func TestJPEGToESCPOSWithMaxWidthHonors58mmCapability(t *testing.T) {
	jpegData := createTestJPEG(576, 1)
	out, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 384)
	if err != nil {
		t.Fatalf("conversion failed: %v", err)
	}
	if got := rasterWidthFromESCPOS(out); got != 48 { // 384 dots => 48 bytes per row
		t.Fatalf("first raster row is %d bytes wide; want 48", got)
	}
}

func TestJPEGToESCPOSWithMaxWidthHonors80mmCapability(t *testing.T) {
	jpegData := createTestJPEG(600, 1)
	out, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 576)
	if err != nil {
		t.Fatalf("conversion failed: %v", err)
	}
	if got := rasterWidthFromESCPOS(out); got != 72 { // 576 dots => 72 bytes per row
		t.Fatalf("first raster row is %d bytes wide; want 72", got)
	}
}
