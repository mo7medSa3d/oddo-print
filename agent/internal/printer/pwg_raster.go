package printer

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"math"
)

// PWG Raster Format PWG 5102.4-2012, section 4:
// "RaS2", one 1796-byte network-order page header per page, followed by
// PackBits-like row/pixel encoding. Does not require CUPS or a printer driver.
//
// The format is losslessly encoded with explicit page boundaries; unlike
// separate JPEG Print-Job requests it supports multi-page documents without
// creating a second (possibly duplicate) physical job.
const (
	pwgPageHeaderBytes = 1796
	maxPDFRasterPixels = 16_000_000
)

type pwgRasterColor int

const (
	pwgGray8 pwgRasterColor = iota // sgray_8 color-space enum 18
	pwgRGB8                        // srgb_8 color-space enum 19
)

// encodePWGPage appends exactly one page to a document which already begins
// with the "RaS2" sync word. It enforces the 5-MiB Agent output bound while
// encoding, so malformed or oversized pages are rejected before the IPP POST.
func encodePWGPage(out *bytes.Buffer, img *image.RGBA, dpi, totalPages int, pageWidthPts, pageHeightPts float64, colorMode pwgRasterColor) error {
	if out == nil || img == nil {
		return fmt.Errorf("nil PWG output or image")
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w <= 0 || h <= 0 || dpi <= 0 || dpi > 1200 || totalPages <= 0 || w > 32767 || h > 32767 ||
		int64(w)*int64(h) > maxPDFRasterPixels || math.IsNaN(pageWidthPts) ||
		math.IsNaN(pageHeightPts) || math.IsInf(pageWidthPts, 0) || math.IsInf(pageHeightPts, 0) || pageWidthPts <= 0 || pageHeightPts <= 0 || pageWidthPts > 32767 || pageHeightPts > 32767 {
		return fmt.Errorf("invalid PWG raster page size/resolution")
	}
	channels, colorSpace := 1, uint32(18) // PWG sgray_8
	if colorMode == pwgRGB8 {
		channels, colorSpace = 3, 19 // PWG srgb_8
	} else if colorMode != pwgGray8 {
		return fmt.Errorf("unsupported PWG color mode")
	}
	header := make([]byte, pwgPageHeaderBytes)
	copy(header[0:64], "PwgRaster")
	put := func(at int, value uint32) { binary.BigEndian.PutUint32(header[at:at+4], value) }
	put(276, uint32(dpi))                       // HWResolution X
	put(280, uint32(dpi))                       // HWResolution Y
	put(352, uint32(math.Round(pageWidthPts)))  // PageSize in points
	put(356, uint32(math.Round(pageHeightPts))) // PageSize in points
	put(372, uint32(w))                         // Width
	put(376, uint32(h))                         // Height
	put(384, 8)                                 // BitsPerColor
	put(388, uint32(channels*8))                // BitsPerPixel
	put(392, uint32(w*channels))                // BytesPerLine
	put(396, 0)                                 // ColorOrder = chunky
	put(400, colorSpace)                        // ColorSpace = sGray/sRGB
	put(420, uint32(channels))                  // NumColors
	put(452, uint32(totalPages))                // TotalPageCount
	put(456, 1)                                 // CrossFeedTransform = normal
	put(460, 1)                                 // FeedTransform = normal
	put(480, 0x00ffffff)                        // AlternatePrimary (white)
	out.Write(header)
	if out.Len() > maxPrintBytes {
		return fmt.Errorf("PWG page header exceeds output budget")
	}

	current := make([]byte, w*channels)
	scratch := make([]byte, w*channels)
	pwgRasterRow(img, 0, current, colorMode)
	for y := 0; y < h; {
		// Consecutive identical rows can be encoded as one row prefixed
		// by count-1 (0..255). This avoids huge white-page allocations.
		run := 1
		for y+run < h && run < 256 {
			pwgRasterRow(img, y+run, scratch, colorMode)
			if !bytes.Equal(current, scratch) {
				break
			}
			run++
		}
		out.WriteByte(byte(run - 1))
		pwgPackRow(out, current, channels)
		if out.Len() > maxPrintBytes {
			return fmt.Errorf("PWG raster exceeds %d-byte Agent job budget", maxPrintBytes)
		}
		y += run
		if y < h {
			pwgRasterRow(img, y, current, colorMode)
		}
	}
	return nil
}

// pwgRasterRow composites the premultiplied Go RGBA image over opaque white.
// A hardware raster cannot represent alpha and must never treat transparent
// PDF backgrounds as black or send premultiplied color values as if opaque.
func pwgRasterRow(img *image.RGBA, y int, row []byte, mode pwgRasterColor) {
	w := img.Bounds().Dx()
	offset := img.PixOffset(img.Rect.Min.X, img.Rect.Min.Y+y)
	channels := 1
	if mode == pwgRGB8 {
		channels = 3
	}
	for x := 0; x < w; x++ {
		p := offset + x*4
		a := uint32(img.Pix[p+3])
		white := uint32(255) - a
		r := min(uint32(255), uint32(img.Pix[p])+white)
		g := min(uint32(255), uint32(img.Pix[p+1])+white)
		b := min(uint32(255), uint32(img.Pix[p+2])+white)
		if channels == 1 {
			row[x] = byte((2126*r + 7152*g + 722*b + 5000) / 10000)
		} else {
			row[x*3] = byte(r)
			row[x*3+1] = byte(g)
			row[x*3+2] = byte(b)
		}
	}
}

// PackBits per *pixel* (one sGray byte or three sRGB bytes), not per byte.
// +N code repeats the next pixel N+1 times, negative code embeds 1-N pixels.
// Some printer decoders mis-handle 129-pixel literals; cap all groups at 128.
func pwgPackRow(out *bytes.Buffer, row []byte, channels int) {
	width := len(row) / channels
	equal := func(a, b int) bool {
		return bytes.Equal(row[a*channels:(a+1)*channels], row[b*channels:(b+1)*channels])
	}
	for x := 0; x < width; {
		run := 1
		for x+run < width && run < 128 && equal(x, x+run) {
			run++
		}
		if run >= 2 {
			out.WriteByte(byte(run - 1))
			out.Write(row[x*channels : (x+1)*channels])
			x += run
			continue
		}
		start := x
		x++
		for x < width && x-start < 128 {
			if x+1 < width && equal(x, x+1) {
				break
			}
			x++
		}
		n := x - start
		out.WriteByte(byte(1 - n))
		out.Write(row[start*channels : x*channels])
	}
}
