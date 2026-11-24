package printer

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"math"
)

const (
	DefaultRasterSliceHeight   = 256
	LowBufferRasterSliceHeight = 128
	MaxJPEGDimension           = 16384
	MaxJPEGPixels              = 40_000_000
	MaxRasterOutputBytes       = 32 * 1024 * 1024
)

// JPEGToESCPOSWithMaxWidth converts a JPEG raster while respecting the
// configured printer width. Unknown or excessive widths fail before allocation.
func JPEGToESCPOSWithMaxWidth(data []byte, sliceHeight, maxWidth int) ([]byte, error) {
	if maxWidth < 1 || maxWidth > MaxJPEGDimension {
		return nil, fmt.Errorf("raster width must be explicitly measured in dots (1..%d)", MaxJPEGDimension)
	}
	return jpegToESCPOS(data, sliceHeight, maxWidth)
}

func jpegToESCPOS(data []byte, sliceHeight, maxWidth int) ([]byte, error) {
	if sliceHeight <= 0 {
		sliceHeight = DefaultRasterSliceHeight
	}
	if sliceHeight > 65535 {
		return nil, fmt.Errorf("raster band height exceeds GS v 0 field limit")
	}
	if maxWidth < 1 || maxWidth > MaxJPEGDimension {
		return nil, fmt.Errorf("raster width must be explicitly measured in dots (1..%d)", MaxJPEGDimension)
	}
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("invalid JPEG dimensions %dx%d", cfg.Width, cfg.Height)
	}
	outputWidth, outputHeight := cfg.Width, cfg.Height
	if outputWidth > maxWidth {
		outputHeight = max(1, int(math.Round(float64(outputHeight)*float64(maxWidth)/float64(outputWidth))))
		outputWidth = maxWidth
	}
	rowBytes := (outputWidth + 7) / 8
	bands := (outputHeight + sliceHeight - 1) / sliceHeight
	rasterBytes := int64(rowBytes)*int64(outputHeight) + int64(bands*8) + 2
	if rasterBytes > MaxRasterOutputBytes {
		return nil, fmt.Errorf("ESC/POS raster output %d bytes exceeds %d limit", rasterBytes, MaxRasterOutputBytes)
	}

	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode JPEG: %w", err)
	}

	// Never exceed the printer's declared raster width. This is deliberately
	// capability-driven rather than inferred from the input image dimensions.
	// Downscaling uses area averaging (resizeArea), not point sampling:
	// a thin stroke that covers part of a destination pixel contributes
	// its coverage to that pixel instead of vanishing or doubling when
	// the scale ratio is not an integer (WP7 measured: 1000->576 px,
	// 18293 disagreements with nearest vs 4142 with area averaging
	// against the same ideal fixture, threshold 180 in both cases).
	if img.Bounds().Dx() > maxWidth {
		img = resizeArea(img, maxWidth)
	}

	bounds := img.Bounds()
	minX, minY := bounds.Min.X, bounds.Min.Y
	w := bounds.Dx()
	h := bounds.Dy()
	rowBytes = (w + 7) / 8

	// Direct pixel-buffer fast paths avoid per-pixel color.Color interface boxing
	// for standard JPEG decoders (*image.YCbCr, *image.Gray) and resized *image.RGBA.
	rgbaImg, isRGBA := img.(*image.RGBA)
	ycbcrImg, isYCbCr := img.(*image.YCbCr)
	grayImg, isGray := img.(*image.Gray)

	exactBands := (h + sliceHeight - 1) / sliceHeight
	out := bytes.NewBuffer(make([]byte, 0, rowBytes*h+exactBands*8+2))
	out.Write([]byte{0x1b, 0x40}) // ESC @ (initialize)

	// Reuse one band buffer across slices instead of allocating per band.
	bandBuf := make([]byte, rowBytes*min(sliceHeight, h))

	// Emit vertical bands
	for yStart := 0; yStart < h; yStart += sliceHeight {
		bandHeight := sliceHeight
		if yStart+bandHeight > h {
			bandHeight = h - yStart
		}
		bandRaster := bandBuf[:rowBytes*bandHeight]
		clear(bandRaster)

		for by := 0; by < bandHeight; by++ {
			actualY := yStart + by
			bandOffset := by * rowBytes

			if isRGBA {
				pixRowOffset := rgbaImg.PixOffset(minX, minY+actualY)
				for x := 0; x < w; x++ {
					pixIdx := pixRowOffset + x*4
					r := uint32(rgbaImg.Pix[pixIdx])
					g := uint32(rgbaImg.Pix[pixIdx+1])
					b := uint32(rgbaImg.Pix[pixIdx+2])
					// Fast integer ITU-R BT.601 luma. The fixed <180 threshold
					// is deliberate and WP7-measured, not a placeholder: on an
					// anti-aliased receipt fixture it kept every >=~30%-coverage
					// stroke (0 disagreements ex-gray-patch at JPEG q90/95/100),
					// while Otsu was unstable across qualities (3338/2/56
					// disagreements) and Floyd-Steinberg error diffusion added
					// ~5.5k disagreements of edge speckle and dither noise.
					// Thermal raster is 1-bit by nature; the goal is the best
					// 1-bit rendering, and a clean threshold preserves QR
					// module geometry better than dithering does.
					luma := uint8((299*r + 587*g + 114*b) / 1000)
					if luma < 180 {
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			} else if isYCbCr {
				yRowOff := ycbcrImg.YOffset(minX, minY+actualY)
				for x := 0; x < w; x++ {
					ci := ycbcrImg.COffset(minX+x, minY+actualY)
					r, g, b := color.YCbCrToRGB(ycbcrImg.Y[yRowOff+x], ycbcrImg.Cb[ci], ycbcrImg.Cr[ci])
					luma := uint8((299*uint32(r) + 587*uint32(g) + 114*uint32(b)) / 1000)
					if luma < 180 {
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			} else if isGray {
				pixRowOffset := grayImg.PixOffset(minX, minY+actualY)
				for x := 0; x < w; x++ {
					if grayImg.Pix[pixRowOffset+x] < 180 {
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			} else {
				for x := 0; x < w; x++ {
					g := grayscale(img.At(minX+x, minY+actualY))
					if g < 180 { // 1-bit high-contrast threshold for crisp Arabic text & QR codes
						bandRaster[bandOffset+x/8] |= 0x80 >> uint(x%8)
					}
				}
			}
		}

		// GS v 0 (raster bit image)
		out.Write([]byte{0x1d, 0x76, 0x30, 0x00})
		out.WriteByte(byte(rowBytes))
		out.WriteByte(byte(rowBytes >> 8))
		out.WriteByte(byte(bandHeight))
		out.WriteByte(byte(bandHeight >> 8))
		out.Write(bandRaster)
	}

	return out.Bytes(), nil
}

func decodeJPEGConfig(data []byte) (image.Config, error) {
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return image.Config{}, fmt.Errorf("invalid JPEG image: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return image.Config{}, fmt.Errorf("invalid JPEG dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if cfg.Width > MaxJPEGDimension || cfg.Height > MaxJPEGDimension {
		return image.Config{}, fmt.Errorf("JPEG dimensions %dx%d exceed %d limit", cfg.Width, cfg.Height, MaxJPEGDimension)
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if pixels > MaxJPEGPixels {
		return image.Config{}, fmt.Errorf("JPEG pixel count %d exceeds %d limit", pixels, MaxJPEGPixels)
	}
	return cfg, nil
}

// resizeArea downscales src to width by exact box (area) averaging: each
// destination pixel is the coverage-weighted mean of the source pixels it
// covers. Integer ratios are exact (every weight is 1); fractional ratios
// distribute each source pixel's ink across the destination pixels it
// overlaps, so a 1-pixel stroke survives as a gray pixel instead of being
// point-sampled away. The result is returned as opaque RGBA with R=G=B=
// averaged luma so the caller's RGBA fast path still applies and the
// downstream fixed-threshold conversion is unchanged. Deterministic: a
// pure function of the input pixels, no time or randomness.
func resizeArea(src image.Image, width int) image.Image {
	if width <= 0 || src.Bounds().Dx() <= width {
		return src
	}
	bounds := src.Bounds()
	sw, sh := bounds.Dx(), bounds.Dy()
	h := max(1, int(math.Round(float64(sh)*float64(width)/float64(sw))))
	// Average luma once; the downstream conversion thresholds luma only,
	// and averaging luma equals averaging the channels for the bilevel and
	// near-gray receipt content this path carries.
	gray := make([]uint8, sw*sh)
	for y := 0; y < sh; y++ {
		rowOff := y * sw
		for x := 0; x < sw; x++ {
			gray[rowOff+x] = grayscale(src.At(bounds.Min.X+x, bounds.Min.Y+y))
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, width, h))
	for y := 0; y < h; y++ {
		y0 := float64(y) * float64(sh) / float64(h)
		y1 := float64(y+1) * float64(sh) / float64(h)
		dstRowOff := y * dst.Stride
		for x := 0; x < width; x++ {
			x0 := float64(x) * float64(sw) / float64(width)
			x1 := float64(x+1) * float64(sw) / float64(width)
			var sum, wsum float64
			for sy := int(y0); sy < int(math.Ceil(y1)) && sy < sh; sy++ {
				wy := math.Min(y1, float64(sy+1)) - math.Max(y0, float64(sy))
				if wy <= 0 {
					continue
				}
				grayRowOff := sy * sw
				for sx := int(x0); sx < int(math.Ceil(x1)) && sx < sw; sx++ {
					wx := math.Min(x1, float64(sx+1)) - math.Max(x0, float64(sx))
					if wx <= 0 {
						continue
					}
					sum += float64(gray[grayRowOff+sx]) * wx * wy
					wsum += wx * wy
				}
			}
			v := uint8(255)
			if wsum > 0 {
				v = uint8(math.Round(sum / wsum))
			}
			dstIdx := dstRowOff + x*4
			dst.Pix[dstIdx] = v
			dst.Pix[dstIdx+1] = v
			dst.Pix[dstIdx+2] = v
			dst.Pix[dstIdx+3] = 255
		}
	}
	return dst
}

func grayscale(c color.Color) uint8 {
	r, g, b, _ := c.RGBA()
	// Integer approximation of ITU-R BT.601 luma.
	return uint8((299*r + 587*g + 114*b) / (1000 * 257))
}

// JPEGToPDF wraps the already-rendered JPEG as a single-page PDF at the
// legacy 96-DPI image geometry. No production flow calls it today: the
// Windows queue embeds images via JPEGToPDFGeometry and the PDF file
// printer via JPEGToPagedPDFGeometry; this wrapper remains test/compat only.
func JPEGToPDF(data []byte) ([]byte, error) {
	return jpegToPDFWithReceiptPaper(data, 0, 0, 0)
}

// JPEGToPDFReceipt maps an Odoo POS receipt from browser CSS pixels to a
// physical roll. The old JPEGToPDF() interpreted every CSS pixel as 1/96in,
// making a 512px ticket ~135mm wide and causing Windows driver page
// substitutions or unexpected shrink/clipping on 58/80mm thermal printers.
//
// The native Windows queue remains authoritative for paper form support:
// the PDF backend verifies it accepts this *physical* page before StartDoc.
// Requires an explicitly configured physical width, printable dots and DPI.
// No production flow routes to this wrapper today; the wired image paths are
// JPEGToPDFGeometry and JPEGToPagedPDFGeometry.
func JPEGToPDFReceipt(data []byte, paperWidthMM, printableDots, dpi int) ([]byte, error) {
	if paperWidthMM <= 0 || paperWidthMM > 10000 || printableDots < 1 || printableDots > MaxJPEGDimension || dpi < 1 || dpi > 9600 {
		return nil, fmt.Errorf("receipt PDF requires explicit physical paper width, printable dots and DPI")
	}
	if float64(printableDots)*25.4/float64(dpi) > float64(paperWidthMM)+25.4/float64(dpi) {
		return nil, fmt.Errorf("printable dots exceed physical paper width at configured DPI")
	}
	return jpegToPDFWithReceiptPaper(data, float64(paperWidthMM), printableDots, dpi)
}

// JPEGToPDFGeometry uses the image's measured printer dots independently on
// each axis. It adds no invented physical margins or assumed browser DPI.
func JPEGToPDFGeometry(data []byte, geometry *Geometry) ([]byte, error) {
	if !geometry.PhysicalImageReady() {
		return nil, CapabilityMismatchf("image PDF requires measured paper_width_mm, dpi_x and dpi_y")
	}
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	if cfg.Width > geometry.PrintableWidthDots {
		return nil, CapabilityMismatchf("image exceeds measured printable width; render again with current geometry")
	}
	return jpegToPDF(data, 0, 0, 0, geometry)
}

func jpegToPDFWithReceiptPaper(data []byte, paperWidthMM float64, printableDots, dpi int) ([]byte, error) {
	return jpegToPDF(data, paperWidthMM, printableDots, dpi, nil)
}

func jpegToPDF(data []byte, paperWidthMM float64, printableDots, dpi int, geometry *Geometry) ([]byte, error) {
	cfg, err := decodeJPEGConfig(data)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("invalid JPEG dimensions %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return nil, fmt.Errorf("decode complete JPEG: %w", err)
	}

	w, h := cfg.Width, cfg.Height

	// Preserve the encoded channel count. Go's supported four-component
	// JPEGs carry Adobe APP14 metadata and inverted CMYK samples (including
	// YCCK, whose transform is selected by DCTDecode from that marker).
	colorSpace := "/DeviceRGB"
	imageDecode := ""
	if cfg.ColorModel == color.GrayModel {
		colorSpace = "/DeviceGray"
	} else if cfg.ColorModel == color.CMYKModel {
		// Keep the original JPEG stream; re-encoding could degrade barcodes.
		colorSpace = "/DeviceCMYK"
		imageDecode = " /Decode [1 0 1 0 1 0 1 0]"
	}

	// Non-receipt documents keep the legacy 96-DPI image geometry.
	pageW := float64(w) * 72.0 / 96.0
	pageH := float64(h) * 72.0 / 96.0
	imageW, imageH := pageW, pageH
	imageX, imageY := 0.0, 0.0
	if paperWidthMM != 0 {
		if math.IsNaN(paperWidthMM) || math.IsInf(paperWidthMM, 0) || paperWidthMM <= 4 || printableDots <= 0 || dpi <= 0 {
			return nil, fmt.Errorf("invalid receipt media geometry")
		}
		pageW = paperWidthMM * 72.0 / 25.4
		// Explicit dot count and DPI define printable content width. Nominal
		// roll millimetres do not imply an extra hardware margin.
		contentMM := float64(printableDots) * 25.4 / float64(dpi)
		if contentMM <= 0 || contentMM > paperWidthMM+25.4/float64(dpi) {
			return nil, fmt.Errorf("printable width exceeds selected physical paper")
		}
		imageW = contentMM * 72.0 / 25.4
		imageH = imageW * float64(h) / float64(w)
		imageX = (pageW - imageW) / 2.0
		imageY = 2.0 * 72.0 / 25.4 // paper-feed margin at bottom
		pageH = imageH + 2.0*imageY
	}

	if geometry != nil {
		pageW = *geometry.PaperWidthMM * 72 / 25.4
		imageW = float64(w) * 72 / float64(*geometry.DPIX)
		imageH = float64(h) * 72 / float64(*geometry.DPIY)
		imageX = (pageW - imageW) / 2
		if geometry.OffsetXDots != nil {
			imageX = (float64(*geometry.OffsetXDots) + float64(geometry.PrintableWidthDots-w)/2) * 72 / float64(*geometry.DPIX)
		}
		imageY = 0
		pageH = imageH
		// Honor the 1-device-pixel physical consistency tolerance from
		// printer-geometry-contract.json (e.g. 576 dots on a 72.0mm @ 203 DPI
		// form where 72.0*203/25.4 = 575.43 dots) without distorting imageW.
		oneDotPt := 72.0 / float64(*geometry.DPIX)
		if imageX < -oneDotPt-1e-7 || imageX+imageW > pageW+oneDotPt+1e-7 {
			return nil, fmt.Errorf("image lies outside measured physical paper")
		}
		if imageX < 0 {
			imageX = 0
		}
		if imageX+imageW > pageW {
			pageW = imageX + imageW
		}
	}

	var b bytes.Buffer
	b.Grow(len(data) + 1024)
	b.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, 6)
	writeObj := func(n int, body []byte) {
		offsets[n] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n", n)
		b.Write(body)
		b.WriteString("\nendobj\n")
	}

	writeObj(1, []byte("<< /Type /Catalog /Pages 2 0 R >>"))
	writeObj(2, []byte("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"))
	pageBody := fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.6f %.6f] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", pageW, pageH)
	writeObj(3, []byte(pageBody))

	imageHeader := fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s%s /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n", w, h, colorSpace, imageDecode, len(data))
	offsets[4] = b.Len()
	fmt.Fprintf(&b, "4 0 obj\n%s", imageHeader)
	b.Write(data)
	b.WriteString("\nendstream\nendobj\n")

	content := fmt.Sprintf("q\n%.6f 0 0 %.6f %.6f %.6f cm\n/Im0 Do\nQ\n", imageW, imageH, imageX, imageY)
	contentBody := fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content)
	writeObj(5, []byte(contentBody))

	xref := b.Len()
	b.WriteString("xref\r\n0 6\r\n0000000000 65535 f\r\n")
	for i := 1; i <= 5; i++ {
		fmt.Fprintf(&b, "%010d 00000 n\r\n", offsets[i])
	}
	fmt.Fprintf(&b, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.Bytes(), nil
}
