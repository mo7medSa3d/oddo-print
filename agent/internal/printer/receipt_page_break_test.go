package printer

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math"
	"testing"

	"github.com/klippa-app/go-pdfium/requests"

	"github.com/yaseir-agent/agent/internal/config"
)

func pageBreakFixture(t *testing.T) ([]byte, *Geometry) {
	t.Helper()
	widthMM, heightMM, dpi := 80.0, 60.0, 203
	rows, zero := 200, 0
	pc := config.PrinterConfig{ID: "receipt", Name: "Receipt printer", Type: "network", Protocol: "raw", Endpoint: "10.0.0.30:9100"}
	pc.GeometryProfile = &config.GeometryProfile{
		PrintableWidthDots:  576,
		PrintableHeightDots: &rows,
		DPIX:                &dpi,
		DPIY:                &dpi,
		PaperWidthMM:        &widthMM,
		PaperHeightMM:       &heightMM,
		OffsetXDots:         &zero,
		OffsetYDots:         &zero,
	}
	g, err := ConfiguredGeometry(pc)
	if err != nil {
		t.Fatal(err)
	}
	source := image.NewGray(image.Rect(0, 0, 576, 350))
	draw.Draw(source, source.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	// A dense code-sized block crosses the old fixed 200-row page boundary.
	// All 80 rows must remain on one page at the original physical scale.
	draw.Draw(source, image.Rect(300, 160, 550, 240), image.NewUniform(color.Black), image.Point{}, draw.Src)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes(), g
}

func TestReceiptSafePageBreaksRetainContiguousRowsAndDriverScale(t *testing.T) {
	data, g := pageBreakFixture(t)
	source, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	segments, err := receiptRasterSegments(source, 200, 203)
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 2 || segments[0].Rows > 160 || segments[1].Start+segments[1].Rows != 350 {
		t.Fatalf("unsafe receipt rows: %+v", segments)
	}
	coverage := 0
	for _, segment := range segments {
		if segment.Start != coverage || segment.Rows < 1 || segment.Rows > 200 {
			t.Fatalf("lost/overlapping source rows: %+v", segments)
		}
		coverage += segment.Rows
	}
	plan := pdfPagePlan{width: *g.PaperWidthMM * 72 / 25.4, height: 350 * 72.0 / 203, crop: &requests.RenderPageCrop{Width: 576 * 72.0 / 203, Height: 350 * 72.0 / 203}}
	parts, err := plan.paginateReceiptJPEG(data, 640, 480, 576, 200, 203, 203, 0, 0)
	if err != nil || len(parts) != 2 {
		t.Fatalf("driver did not use safe row boundaries: %+v %v", parts, err)
	}
	covered := 0.0
	for i, part := range parts {
		_, _, w, h, err := part.printableDestination(640, 480, 576, 200, 203, 203, 0, 0)
		if err != nil || w != 576 || h != segments[i].Rows || math.Abs(part.crop.Y-covered) > 1e-7 {
			t.Fatalf("driver shrank or lost rows: %dx%d %+v %v", w, h, part, err)
		}
		covered += part.crop.Height
	}
	if math.Abs(covered-plan.crop.Height) > 1e-7 {
		t.Fatal("driver image coverage changed")
	}
}

func TestPagedPDFPageBreakKeepsCodeBlockTogether(t *testing.T) {
	data, g := pageBreakFixture(t)
	pdf, err := JPEGToPagedPDFGeometry(data, g)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := getPDFiumPool()
	if err != nil {
		t.Fatal(err)
	}
	worker, err := pool.GetInstanceWithContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	document, err := worker.OpenDocument(&requests.OpenDocument{File: &pdf})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: document.Document})
	count, err := worker.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: document.Document})
	if err != nil || count.PageCount != 2 {
		t.Fatalf("expected two readable pages: %+v %v", count, err)
	}
	blackRows := make([]int, 2)
	for index := range blackRows {
		rendered, err := worker.RenderPageInPixels(&requests.RenderPageInPixels{Page: requests.Page{ByIndex: &requests.PageByIndex{Document: document.Document, Index: index}}, Width: 576, Height: 200, Crop: &requests.RenderPageCrop{Width: 576 * 72.0 / 203, Height: 200 * 72.0 / 203}})
		if err != nil {
			t.Fatal(err)
		}
		bitmap := rendered.Result.Image
		for y := 0; y < bitmap.Bounds().Dy(); y++ {
			if grayscale(bitmap.At(400, y)) < 64 {
				blackRows[index]++
			}
		}
		rendered.Cleanup()
	}
	if blackRows[0] != 0 || blackRows[1] < 79 || blackRows[1] > 81 {
		t.Fatalf("code block was split or scaled across pages: black rows %v, want [0,80]", blackRows)
	}
}

func TestPagedPDFRejectsUnsafeOpaqueImagePagination(t *testing.T) {
	_, g := pageBreakFixture(t)
	source := image.NewGray(image.Rect(0, 0, 576, 350))
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	if _, err := JPEGToPagedPDFGeometry(encoded.Bytes(), g); err == nil {
		t.Fatal("opaque continuous raster was split without a safe page gap")
	}
}
