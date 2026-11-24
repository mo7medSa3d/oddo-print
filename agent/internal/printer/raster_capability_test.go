package printer

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
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
	if got := RasterMaxWidthFromPaperWidthMM(80); got != 0 {
		t.Fatalf("80mm unknown-DPI paper: got %d dots, want unknown (0)", got)
	}
}

func TestRasterWidthHonorsReal80mmResolutionAndOperatorDots(t *testing.T) {
	for _, test := range []struct {
		caps map[string]interface{}
		want int
	}{
		{map[string]interface{}{"print_dpi": 180}, 0},
		{map[string]interface{}{"print_dpi": 203}, 0},
		{map[string]interface{}{"print_dpi": 180, "max_paper_width": 512}, 512},
		{map[string]interface{}{"print_dpi": 203, "max_paper_width": 512}, 512},
		{map[string]interface{}{"max_paper_width": 576}, 576},
		{nil, 0},
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
		{"unknown", nil, 0},
		{"explicit 58mm", map[string]interface{}{"max_paper_width": 58}, 0},
		{"explicit 576 dots", map[string]interface{}{"max_paper_width": 576}, 576},
		{"legacy narrow set", map[string]interface{}{"paper_widths": []int{58, 80}}, 0},
		{"json numbers", map[string]interface{}{"paper_widths": []interface{}{80.0}}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RasterMaxWidthFromCapabilities(tc.caps); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestRasterMaxWidthRejectsSoftwareBoundInsteadOfGuessingHardware(t *testing.T) {
	for _, value := range []interface{}{0, -1, 80, MaxJPEGDimension + 1, 1e30, "broken"} {
		if got := RasterMaxWidthFromCapabilities(map[string]interface{}{"max_paper_width": value}); got != 0 {
			t.Fatalf("invalid value %v became %d dots", value, got)
		}
	}
	if got := RasterMaxWidthFromCapabilities(map[string]interface{}{"max_paper_width": 5000}); got != 5000 {
		t.Fatalf("explicit bounded width was altered: %d", got)
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

func TestReceiptRasterRetainsBothBoundaryMarksAcrossBands(t *testing.T) {
	source, err := os.ReadFile("testdata/receipt-geometry.jpg")
	if err != nil {
		t.Fatal(err)
	}
	for _, width := range []int{288, 360, 384, 420, 512, 552, 560, 576} {
		data, err := JPEGToESCPOSWithMaxWidth(source, 128, width)
		if err != nil {
			t.Fatal(err)
		}
		rowBytes, rows := (min(width, 512)+7)/8, []byte{}
		for offset := 2; offset < len(data); {
			if offset+8 > len(data) || !bytes.Equal(data[offset:offset+4], []byte{0x1d, 0x76, 0x30, 0}) {
				t.Fatal("invalid raster band header")
			}
			w, h := int(binary.LittleEndian.Uint16(data[offset+4:])), int(binary.LittleEndian.Uint16(data[offset+6:]))
			if w != rowBytes || h < 1 || h > 128 || offset+8+w*h > len(data) {
				t.Fatal("invalid raster band dimensions")
			}
			rows = append(rows, data[offset+8:offset+8+w*h]...)
			offset += 8 + w*h
		}
		height := len(rows) / rowBytes
		if height != int(math.Round(2852*float64(min(width, 512))/512)) {
			t.Fatal("receipt height changed during banding")
		}
		for _, start := range []int{0, height - 32} {
			found := false
			for y := start; y < start+32; y++ {
				found = found || (rows[y*rowBytes+1] != 0 && rows[(y+1)*rowBytes-2] != 0)
			}
			if !found {
				t.Fatalf("%d-dot target lost a left/right registration mark near row %d", width, start)
			}
		}
	}
}
