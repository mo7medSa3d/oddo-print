package printer

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"testing"
)

// The test decoder does not call the encoder. It independently checks
// 5102.4 row repetition, pixel PackBits and page boundaries.
func decodeTestPWGPage(stream []byte, at int) ([][]byte, int, error) {
	if at+pwgPageHeaderBytes > len(stream) {
		return nil, at, fmt.Errorf("truncated page header")
	}
	hdr := stream[at : at+pwgPageHeaderBytes]
	w := int(binary.BigEndian.Uint32(hdr[372:376]))
	h := int(binary.BigEndian.Uint32(hdr[376:380]))
	channels := int(binary.BigEndian.Uint32(hdr[420:424]))
	if w <= 0 || h <= 0 || channels <= 0 || w > 1000 || h > 1000 || channels > 3 {
		return nil, at, fmt.Errorf("invalid page geometry")
	}
	pos := at + pwgPageHeaderBytes
	rows := make([][]byte, 0, h)
	for len(rows) < h {
		if pos >= len(stream) {
			return nil, pos, fmt.Errorf("truncated row prefix")
		}
		repeats := int(stream[pos]) + 1
		pos++
		row := make([]byte, 0, w*channels)
		for len(row) < w*channels {
			if pos >= len(stream) {
				return nil, pos, fmt.Errorf("truncated PackBits")
			}
			code := int(int8(stream[pos]))
			pos++
			if code >= 0 {
				if pos+channels > len(stream) {
					return nil, pos, fmt.Errorf("truncated duplicate pixel")
				}
				for i := 0; i < code+1; i++ {
					row = append(row, stream[pos:pos+channels]...)
				}
				pos += channels
			} else {
				n := 1 - code
				if pos+n*channels > len(stream) {
					return nil, pos, fmt.Errorf("truncated literal run")
				}
				row = append(row, stream[pos:pos+n*channels]...)
				pos += n * channels
			}
			if len(row) > w*channels {
				return nil, pos, fmt.Errorf("row overrun")
			}
		}
		for i := 0; i < repeats; i++ {
			rows = append(rows, append([]byte(nil), row...))
		}
		if len(rows) > h {
			return nil, pos, fmt.Errorf("repeated row overrun")
		}
	}
	return rows, pos, nil
}

func TestPWGRasterHeaderAndGrayRLE(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			value := uint8(0)
			if x >= 2 {
				value = 255
			}
			img.SetRGBA(x, y, color.RGBA{R: value, G: value, B: value, A: 255})
		}
	}
	var out bytes.Buffer
	out.WriteString("RaS2")
	if err := encodePWGPage(&out, img, 300, 2, 72, 54, pwgGray8); err != nil {
		t.Fatal(err)
	}
	doc := out.Bytes()
	if !bytes.Equal(doc[:4], []byte("RaS2")) || !bytes.Equal(doc[4:13], []byte("PwgRaster")) {
		t.Fatal("wrong PWG sync/header")
	}
	hdr := doc[4 : 4+pwgPageHeaderBytes]
	cases := []struct {
		offset int
		want   uint32
	}{
		{276, 300}, {280, 300}, {352, 72}, {356, 54}, {372, 4}, {376, 3},
		{384, 8}, {388, 8}, {392, 4}, {396, 0}, {400, 18}, {420, 1},
		{452, 2}, {456, 1}, {460, 1},
	}
	for _, tc := range cases {
		if got := binary.BigEndian.Uint32(hdr[tc.offset : tc.offset+4]); got != tc.want {
			t.Errorf("header[%d]=%d want=%d", tc.offset, got, tc.want)
		}
	}
	rows, end, err := decodeTestPWGPage(doc, 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || end != len(doc) {
		t.Fatalf("page rows=%d end=%d len=%d", len(rows), end, len(doc))
	}
	for _, row := range rows {
		if !bytes.Equal(row, []byte{0, 0, 255, 255}) {
			t.Fatalf("decoded row=%x", row)
		}
	}
	if got := doc[4+pwgPageHeaderBytes]; got != 2 {
		t.Errorf("duplicate row code=%d want=2", got)
	}
}

func TestPWGRasterRGBAndMultiplePageBoundaries(t *testing.T) {
	var out bytes.Buffer
	out.WriteString("RaS2")
	for page := 0; page < 2; page++ {
		img := image.NewRGBA(image.Rect(0, 0, 257, 2))
		for y := 0; y < 2; y++ {
			for x := 0; x < 257; x++ {
				img.SetRGBA(x, y, color.RGBA{R: uint8(x + page), G: uint8(x*3 + y), B: uint8(255 - x), A: 255})
			}
		}
		if err := encodePWGPage(&out, img, 300, 2, 72, 72, pwgRGB8); err != nil {
			t.Fatal(err)
		}
	}
	pos := 4
	for page := 0; page < 2; page++ {
		got := binary.BigEndian.Uint32(out.Bytes()[pos+400 : pos+404])
		if got != 19 {
			t.Fatalf("page %d color space=%d", page, got)
		}
		rows, next, err := decodeTestPWGPage(out.Bytes(), pos)
		if err != nil {
			t.Fatal(err)
		}
		for y, row := range rows {
			for x := 0; x < 257; x++ {
				want := []byte{uint8(x + page), uint8(x*3 + y), uint8(255 - x)}
				if !bytes.Equal(row[x*3:x*3+3], want) {
					t.Fatalf("page=%d x=%d y=%d color=%x want=%x", page, x, y, row[x*3:x*3+3], want)
				}
			}
		}
		pos = next
	}
	if pos != out.Len() {
		t.Fatalf("trailing bytes %d", out.Len()-pos)
	}
}

func TestPWGResolutionAndColorOptionSelection(t *testing.T) {
	cases := []struct {
		attrs map[string]string
		dpi   int
		mode  pwgRasterColor
		fails bool
	}{
		{nil, 300, pwgGray8, false},
		{map[string]string{"pwg-raster-document-resolution-supported": "600x600dpi,150x150dpi,300x300dpi", "pwg-raster-document-type-supported": "srgb_8,sgray_8"}, 300, pwgGray8, false},
		{map[string]string{"pwg-raster-document-resolution-supported": "600x600dpi", "pwg-raster-document-type-supported": "srgb_8"}, 600, pwgRGB8, false},
		{map[string]string{"pwg-raster-document-resolution-supported": "300x200dpi"}, 0, pwgGray8, true},
		{map[string]string{"pwg-raster-document-type-supported": "sgray_1"}, 0, pwgGray8, true},
	}
	for i, tc := range cases {
		dpi, mode, err := pwgOptionsFromIPPAttributes(tc.attrs)
		if (err != nil) != tc.fails {
			t.Fatalf("case %d err=%v", i, err)
		}
		if !tc.fails && (dpi != tc.dpi || mode != tc.mode) {
			t.Errorf("case %d dpi=%d color=%d", i, dpi, mode)
		}
	}
}
