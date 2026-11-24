package printer

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"regexp"
	"strconv"
	"testing"
)

// Extract just the image stream, without using the conversion implementation
// as a decoder. The separate audit interoperability lane uses native Poppler.
func pdfImageStream(t *testing.T, pdf []byte) []byte {
	t.Helper()
	pattern := regexp.MustCompile(`/Subtype /Image[^\n]* /Length ([0-9]+) >>\nstream\n`)
	match := pattern.FindSubmatchIndex(pdf)
	if match == nil {
		t.Fatal("missing PDF image stream")
	}
	length, err := strconv.Atoi(string(pdf[match[2]:match[3]]))
	if err != nil || length > len(pdf)-match[1] {
		t.Fatal("invalid PDF image stream length")
	}
	return pdf[match[1] : match[1]+length]
}

func TestJPEGToPDFCMYKPreservesFourChannelsAndEncodedContent(t *testing.T) {
	input, err := os.ReadFile("testdata/cmyk-patches.jpg")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(input))
	if err != nil || cfg.ColorModel != color.CMYKModel {
		t.Fatal("fixture must be a real four-component CMYK JPEG")
	}
	for _, receipt := range []bool{false, true} {
		name := "document"
		if receipt {
			name = "thermal58"
		}
		t.Run(name, func(t *testing.T) {
			var output []byte
			if receipt {
				output, err = JPEGToPDFReceipt(input, 58, 384, 203)
			} else {
				output, err = JPEGToPDF(input)
			}
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(output, []byte("/ColorSpace /DeviceCMYK")) || !bytes.Contains(output, []byte("/Decode [1 0 1 0 1 0 1 0]")) {
				t.Fatal("Adobe four-component image must retain CMYK channels and inverted sample decoding")
			}
			if !bytes.Equal(pdfImageStream(t, output), input) {
				t.Fatal("conversion must not re-encode the supplied raster")
			}
		})
	}
}

func TestJPEGToPDFRejectsMalformedCMYKBeforeWrapping(t *testing.T) {
	input, err := os.ReadFile("testdata/cmyk-patches.jpg")
	if err != nil {
		t.Fatal(err)
	}
	truncated := input[:len(input)/2]
	if _, err := jpeg.DecodeConfig(bytes.NewReader(truncated)); err != nil {
		t.Fatalf("fixture should retain valid size/color header: %v", err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(truncated)); err == nil {
		t.Fatal("fixture must have a corrupt image body")
	}
	if output, err := JPEGToPDF(truncated); err == nil || output != nil {
		t.Fatal("invalid CMYK content must be refused before any submission")
	}
}

func TestJPEGToPDFRGBAndGrayKeepEncodedBytes(t *testing.T) {
	gray := image.NewGray(image.Rect(0, 0, 13, 9))
	gray.SetGray(6, 4, color.Gray{Y: 150})
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, gray, nil); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name, space string
		input       []byte
	}{
		{"RGB", "/DeviceRGB", createTestJPEG(12, 18)},
		{"gray", "/DeviceGray", buffer.Bytes()},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			output, err := JPEGToPDF(fixture.input)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(output, []byte("/ColorSpace "+fixture.space)) || bytes.Contains(output, []byte("/Decode [")) {
				t.Fatal("existing color space changed")
			}
			if !bytes.Equal(pdfImageStream(t, output), fixture.input) {
				t.Fatal("existing JPEG bytes changed")
			}
		})
	}
}
