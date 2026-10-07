package printer

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
)

func TestPDFPaperPreservesStandardCustomAndLandscapeSizes(t *testing.T) {
	for _, tc := range []struct {
		name            string
		w, h            float64
		id, orientation int16
	}{
		{"A4", 595.276, 841.89, 9, 1}, {"Letter", 612, 792, 1, 1}, {"Legal", 612, 1008, 5, 1},
		{"landscape", 841.89, 595.276, 9, 2}, {"58mm receipt", 58 * 72 / 25.4, 180 * 72 / 25.4, 0, 1},
		{"80mm receipt", 80 * 72 / 25.4, 250 * 72 / 25.4, 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := pdfPaperForPoints(tc.w, tc.h)
			if err != nil || p.ID != tc.id || p.Orientation != tc.orientation {
				t.Fatalf("paper=%+v error=%v", p, err)
			}
		})
	}
	for _, value := range []float64{0, -1, math.NaN(), math.Inf(1), 100000} {
		if _, err := pdfPaperForPoints(value, 842); err == nil {
			t.Fatalf("invalid size %v accepted", value)
		}
	}
}

func TestPDFDevModeRetainsPrivateDataAndDisablesDriverScaling(t *testing.T) {
	buf := bytes.Repeat([]byte{0xab}, 236)
	binary.LittleEndian.PutUint16(buf[68:70], 220)
	binary.LittleEndian.PutUint16(buf[70:72], 16)
	binary.LittleEndian.PutUint32(buf[72:76], 0x10000|0x800) // default form plus duplex
	private := append([]byte(nil), buf[220:]...)
	p, _ := pdfPaperForPoints(792, 612)
	if err := configurePDFDevMode(buf, p); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(private, buf[220:]) {
		t.Fatal("driver private DEVMODE data was damaged")
	}
	if binary.LittleEndian.Uint16(buf[84:86]) != 100 || binary.LittleEndian.Uint16(buf[86:88]) != 1 {
		t.Fatal("driver scaling/copy default was not normalized")
	}
	flags := binary.LittleEndian.Uint32(buf[72:76])
	if flags&0x10000 != 0 || flags&0x800 == 0 {
		t.Fatalf("unexpected driver field flags: %x", flags)
	}
	if flags&0xc != 0 {
		t.Fatal("standard paper ID must not also specify custom paper dimensions")
	}
	custom, _ := pdfPaperForPoints(58*72/25.4, 180*72/25.4)
	if err := configurePDFDevMode(buf, custom); err != nil {
		t.Fatal(err)
	}
	if binary.LittleEndian.Uint16(buf[78:80]) != 0 || binary.LittleEndian.Uint32(buf[72:76])&0xc != 0xc {
		t.Fatal("custom paper must specify dimensions with a zero paper ID")
	}
	if err := configurePDFDevMode(buf[:220], p); err == nil {
		t.Fatal("truncated driver-private bytes accepted")
	}
}

func TestPDFRejectsDefaultSheetSubstitution(t *testing.T) {
	if err := validatePDFSheet(612, 792, 2550, 3300, 300, 300); err != nil {
		t.Fatal(err)
	}
	if err := validatePDFSheet(58*72/25.4, 180*72/25.4, 2550, 3300, 300, 300); err == nil {
		t.Fatal("receipt silently enlarged to Letter")
	}
	if err := validatePDFSheet(792, 612, 2550, 3300, 300, 300); err == nil {
		t.Fatal("landscape silently changed to portrait")
	}
	if err := validatePDFSheet(612, 792, 2550, 3300, 0, 300); err == nil {
		t.Fatal("invalid DPI accepted")
	}
	if err := validatePDFSheet(math.NaN(), 792, 2550, 3300, 300, 300); err == nil {
		t.Fatal("invalid PDF dimensions accepted")
	}
}

func TestPDFDevModeRejectsDriverSubstitutedScalingAndCopies(t *testing.T) {
	buf := make([]byte, 236)
	binary.LittleEndian.PutUint16(buf[68:70], 220)
	binary.LittleEndian.PutUint16(buf[70:72], 16)
	paper, _ := pdfPaperForPoints(612, 792)
	if err := configurePDFDevMode(buf, paper); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		offset int
		value  uint16
	}{
		{"half scale", 84, 50}, {"enlarged scale", 84, 125},
		{"duplicate copies", 86, 2}, {"zero copies", 86, 0},
		{"invalid public size", 68, 70}, {"truncated private data", 70, 17},
	} {
		t.Run(tc.name, func(t *testing.T) {
			returned := append([]byte(nil), buf...)
			binary.LittleEndian.PutUint16(returned[tc.offset:tc.offset+2], tc.value)
			before := append([]byte(nil), returned...)
			if err := validatePDFDevModeResult(returned); err == nil {
				t.Fatal("unsafe driver output reached printer DC creation")
			}
			if !bytes.Equal(before, returned) {
				t.Fatal("validation rewrote driver-owned data")
			}
		})
	}
	if err := validatePDFDevModeResult(buf); err != nil {
		t.Fatalf("unchanged settings refused: %v", err)
	}
	// Drivers without these optional fields may leave arbitrary unused bytes.
	binary.LittleEndian.PutUint32(buf[72:76], binary.LittleEndian.Uint32(buf[72:76])&^uint32(0x10|0x100))
	binary.LittleEndian.PutUint16(buf[84:86], 50)
	binary.LittleEndian.PutUint16(buf[86:88], 2)
	if err := validatePDFDevModeResult(buf); err != nil {
		t.Fatalf("unused driver fields were interpreted as settings: %v", err)
	}
	if err := validatePDFDevModeResult(buf[:90]); err == nil {
		t.Fatal("truncated public DEVMODE accepted")
	}
}

func TestPDFPhysicalOriginPreservesMarginsWithoutFitScaling(t *testing.T) {
	x, y, w, h, err := pdfBitmapDestination(2550, 3300, 75, 90)
	if err != nil || x != -75 || y != -90 || w != 2550 || h != 3300 {
		t.Fatalf("physical origin/scale changed: %d,%d %dx%d %v", x, y, w, h, err)
	}
	for _, offsets := range [][2]int{{-1, 0}, {0, -1}, {2550, 0}, {0, 3300}} {
		if _, _, _, _, err := pdfBitmapDestination(2550, 3300, offsets[0], offsets[1]); err == nil {
			t.Fatalf("invalid physical origin accepted: %v", offsets)
		}
	}
}
