package printer

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func TestIPPJPEGRasterHasJFIFv102Metadata(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 20, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 20; x++ {
			img.SetRGBA(x, y, color.RGBA{R: 180, G: 10, B: 30, A: 255})
		}
	}
	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(jpegBytes.Bytes()[:min(24, jpegBytes.Len())], []byte("JFIF")) {
		t.Fatal("Go image/jpeg unexpectedly added JFIF; update regression assumptions")
	}
	jfif, err := wrapIPPPayloadAsJFIF(jpegBytes.Bytes(), 200)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := []byte{0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0, 1, 2, 1, 0, 200, 0, 200, 0, 0}
	if !bytes.HasPrefix(jfif, wantPrefix) {
		t.Fatalf("JPEG missing correct JFIF v1.02 and DPI header: %x", jfif[:min(len(jfif), 32)])
	}
	if _, err := jpeg.Decode(bytes.NewReader(jfif)); err != nil {
		t.Fatalf("JFIF-wrapped JPEG cannot be decoded: %v", err)
	}
	repeated, err := wrapIPPPayloadAsJFIF(jfif, 200)
	if err != nil || !bytes.Equal(repeated, jfif) {
		t.Fatal("valid JFIF must not be double-wrapped")
	}
}

func TestIPPRejectsInvalidJFIFInputs(t *testing.T) {
	for _, doc := range [][]byte{nil, {}, []byte("not-jpeg")} {
		if _, err := wrapIPPPayloadAsJFIF(doc, 200); err == nil {
			t.Fatalf("invalid JPEG was accepted")
		}
	}
	if _, err := wrapIPPPayloadAsJFIF([]byte{0xff, 0xd8, 0xff, 0xdb}, 0); err == nil {
		t.Fatal("invalid zero DPI accepted")
	}
}
