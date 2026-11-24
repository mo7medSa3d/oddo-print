package printer

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
)

func TestRasterOddWidthKeepsRightEdgeAndWhitePackedPadding(t *testing.T) {
	for _, width := range []int{384, 576, 850, 851, 1700, 1702} {
		const height = 513
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, image.NewGray(image.Rect(0, 0, width, height)), &jpeg.Options{Quality: 95}); err != nil {
			t.Fatal(err)
		}
		geometry := testRasterGeometry(width)
		data, err := prepareESCPOSImage("escpos", geometry, Document{Kind: KindImage, Data: encoded.Bytes(), GeometryFingerprint: geometry.ConfigFingerprint})
		if err != nil {
			t.Fatal(err)
		}
		rows := 0
		for offset := 2; offset < len(data); {
			if offset+8 > len(data) || !bytes.Equal(data[offset:offset+4], []byte{0x1d, 0x76, 0x30, 0}) {
				t.Fatal("raster changed1x1 command mode")
			}
			rowBytes := int(binary.LittleEndian.Uint16(data[offset+4:]))
			bandHeight := int(binary.LittleEndian.Uint16(data[offset+6:]))
			if rowBytes != (width+7)/8 || bandHeight < 1 || bandHeight > 256 || offset+8+rowBytes*bandHeight > len(data) {
				t.Fatal("raster dimensions changed")
			}
			wantLast := byte(0xff)
			if remainder := width % 8; remainder != 0 {
				wantLast = byte(0xff << uint(8-remainder))
			}
			for y := 0; y < bandHeight; y++ {
				row := data[offset+8+y*rowBytes : offset+8+(y+1)*rowBytes]
				if row[0] != 0xff || row[len(row)-1] != wantLast {
					t.Fatalf("width%d lost edge or added ink outside geometry: first=%02x last=%02x want=%02x", width, row[0], row[len(row)-1], wantLast)
				}
			}
			rows += bandHeight
			offset += 8 + rowBytes*bandHeight
		}
		if rows != height {
			t.Fatalf("width%d altered height: %d", width, rows)
		}
	}
}

func TestRasterBandFieldOverflowFailsBeforeOutput(t *testing.T) {
	if data, err := JPEGToESCPOSWithMaxWidth(createTestJPEG(8, 8), 65536, 8); err == nil || len(data) != 0 {
		t.Fatal("overflowed GS v0 height field was emitted")
	}
}

func createTestJPEG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if (x+y)%2 == 0 {
				img.Set(x, y, color.Black)
			} else {
				img.Set(x, y, color.White)
			}
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	return buf.Bytes()
}

func TestJPEGConfigRejectsUnsafeDimensionsBeforeDecode(t *testing.T) {
	jpegData := createTestJPEG(1, 1)
	// SOF0 dimensions follow the marker, segment length, precision byte.
	for i := 0; i+8 < len(jpegData); i++ {
		if jpegData[i] == 0xff && jpegData[i+1] == 0xc0 {
			jpegData[i+5], jpegData[i+6] = 0xff, 0xff
			jpegData[i+7], jpegData[i+8] = 0xff, 0xff
			break
		}
	}
	if _, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 576); err == nil || !strings.Contains(err.Error(), "dimensions") {
		t.Fatalf("expected pre-decode dimension rejection, got %v", err)
	}
}

func TestAdaptiveRasterBanding(t *testing.T) {
	// A 600px tall receipt image should be split into 3 bands when sliceHeight is 256
	jpegData := createTestJPEG(576, 600)

	escpos, err := JPEGToESCPOSWithMaxWidth(jpegData, 256, 576)
	if err != nil {
		t.Fatalf("JPEGToESCPOSWithBanding failed: %v", err)
	}

	// Count occurrences of GS v 0 (\x1d\x76\x30\x00)
	gsV0 := []byte{0x1d, 0x76, 0x30, 0x00}
	count := bytes.Count(escpos, gsV0)
	if count != 3 {
		t.Fatalf("expected 3 raster bands for 600px image with sliceHeight=256, got %d", count)
	}

	// Test fallback for low-buffer printers (128px)
	escposLowBuffer, err := JPEGToESCPOSWithMaxWidth(jpegData, 128, 576)
	if err != nil {
		t.Fatalf("JPEGToESCPOSWithBanding (128px) failed: %v", err)
	}
	countLow := bytes.Count(escposLowBuffer, gsV0)
	if countLow != 5 { // 600 / 128 = 4 with 88 remainder => 5 bands
		t.Fatalf("expected 5 raster bands for 600px image with sliceHeight=128, got %d", countLow)
	}
}

func TestWideOneRowJPEGStillEmitsRasterData(t *testing.T) {
	data := createTestJPEG(16384, 1)
	output, err := JPEGToESCPOSWithMaxWidth(data, 256, 384)
	if err != nil {
		t.Fatal(err)
	}
	marker := []byte{0x1d, 0x76, 0x30, 0x00}
	offset := bytes.Index(output, marker)
	if offset < 0 || offset+8+48 > len(output) {
		t.Fatalf("image became initialization-only output: %d bytes", len(output))
	}
	if output[offset+6] != 1 || output[offset+7] != 0 {
		t.Fatal("resized one-row image lacks a raster row")
	}
}
