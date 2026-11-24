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
	"time"

	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
)

func TestReceiptPDFUsesPrintableContentWidthOnce(t *testing.T) {
	data, err := jpegToPDFWithReceiptPaper(testReceiptJPEG(t, 576, 900), 640*25.4/203, 576, 203)
	if err != nil {
		t.Fatal(err)
	}
	pageW, pageH, imageW, _, _, _ := pdfImageGeometry(t, data)
	plan := pdfPagePlan{width: pageW, height: pageH, crop: &requests.RenderPageCrop{Width: imageW, Height: pageH}}
	_, y, w, _, err := plan.printableDestination(640, 28000, 576, 27976, 203, 203, 32, 12)
	if err != nil {
		t.Fatal(err)
	}
	usefulWidth := float64(w)
	if math.Abs(usefulWidth-576) > 1 || y != 0 {
		t.Fatalf("receipt fitted twice or centered down long form: useful width %.2f dots, Y=%d; want 576 dots and Y=0", usefulWidth, y)
	}
	plan.crop = nil
	_, genericY, genericW, _, err := plan.printableDestination(640, 28000, 576, 27976, 203, 203, 32, 12)
	// An ordinary PDF on a physically long receipt roll now also begins at
	// the feed origin. Only the owned receipt crop avoids the second width
	// reduction; top-alignment must not hide the 518-dot generic scaling.
	if err != nil || genericY != 0 || math.Abs(float64(genericW)*imageW/pageW-518.4) > 1 {
		t.Fatalf("ordinary PDF roll alignment or generic scale changed: %d,%d %v", genericY, genericW, err)
	}
}

func TestReceiptPDFCropRetainsEverySourceEdgeAndFeedMargin(t *testing.T) {
	frame := image.NewGray(image.Rect(0, 0, 576, 900))
	draw.Draw(frame, image.Rect(12, 12, 564, 888), image.NewUniform(color.White), image.Point{}, draw.Src)
	var source bytes.Buffer
	if err := jpeg.Encode(&source, frame, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	data, err := jpegToPDFWithReceiptPaper(source.Bytes(), 640*25.4/203, 576, 203)
	if err != nil {
		t.Fatal(err)
	}
	pageW, pageH, imageW, imageH, imageX, imageY := pdfImageGeometry(t, data)
	pool, err := webassembly.Init(newPDFiumPoolConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	worker, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	doc, err := worker.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})
	page := requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}}
	crop, err := receiptPDFCrop(worker, page, pageW, pageH)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(crop.X-imageX) > .01 || math.Abs(crop.Width-imageW) > .01 || crop.Y != 0 || crop.Height != pageH {
		t.Fatalf("crop removed image or feed margins: %+v", crop)
	}
	plan := pdfPagePlan{width: pageW, height: pageH, crop: crop}
	_, y, w, h, err := plan.printableDestination(640, 28000, 576, 27976, 203, 203, 32, 12)
	if err != nil || w < 575 || w > 576 || y != 0 {
		t.Fatalf("receipt destination changed: Y=%d %dx%d %v", y, w, h, err)
	}
	rendered, err := worker.RenderPageInPixels(&requests.RenderPageInPixels{Page: page, Width: w, Height: h, Crop: crop})
	if err != nil {
		t.Fatal(err)
	}
	defer rendered.Cleanup()
	img := rendered.Result.Image
	if img == nil || img.Rect.Dx() < 574 || img.Rect.Dx() > 576 || img.Rect.Dy() > h {
		t.Fatalf("receipt render lost useful width: %+v", rendered.Result)
	}
	for _, point := range [][2]float64{
		{imageX + imageW*4/576, imageY + imageH/2},
		{imageX + imageW*(1-4.0/576), imageY + imageH/2},
		{imageX + imageW/2, imageY + imageH*4/900},
		{imageX + imageW/2, imageY + imageH*(1-4.0/900)},
	} {
		x := int((point[0] - crop.X) / crop.Width * float64(img.Rect.Dx()))
		y := int((pageH - point[1]) / pageH * float64(img.Rect.Dy()))
		pixel := img.RGBAAt(x, y)
		if pixel.R > 64 || pixel.G > 64 || pixel.B > 64 || pixel.A != 255 {
			t.Fatalf("source image edge missing at %d,%d: %v", x, y, pixel)
		}
	}
	for _, y := range []int{0, img.Rect.Dy() - 1, img.Rect.Dy() / 2} {
		if pixel := img.RGBAAt(img.Rect.Dx()/2, y); pixel.R < 240 || pixel.G < 240 || pixel.B < 240 || pixel.A != 255 {
			t.Fatalf("feed margin/interior was lost at Y=%d: %v", y, pixel)
		}
	}
	if _, err := receiptPDFCrop(worker, page, 1, pageH); err == nil {
		t.Fatal("out-of-page receipt image accepted")
	}
	ordinary := validPDF()
	other, err := worker.OpenDocument(&requests.OpenDocument{File: &ordinary})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: other.Document})
	if _, err := receiptPDFCrop(worker, requests.Page{ByIndex: &requests.PageByIndex{Document: other.Document, Index: 0}}, 595, 842); err == nil {
		t.Fatal("unexpected PDF structure accepted as an owned receipt")
	}
}
