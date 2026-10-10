//go:build windows

package printer

import (
	"context"
	"fmt"
	"image"
	"io"
	"log"
	"math"
	"os"
	"strconv"
	"sync"
	"time"
	"unsafe"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/responses"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"golang.org/x/sys/windows"
)

// Embedded Windows PDF pipeline.
//
// PDFium runs in an embedded WebAssembly module through wazero. go-pdfium's
// WebAssembly implementation embeds the PDFium WASM binary, so the Agent has
// no PDFium DLL, native PDF runtime, desktop PDF application, registry association,
// PATH requirement, or runtime download.
//
// Pages are rendered one at a time and submitted through a printer HDC using
// Windows GDI. The same Windows printer stack remains responsible for printer
// selection and physical spooling; RAW/ESC-POS traffic never enters this path.

const (
	maxPDFPages        = 500
	maxPDFRenderPixels = 16_000_000 // <= 64 MiB for one 32-bit bitmap.
	maxPDFDevModeBytes = 8 * 1024 * 1024

	// GetDeviceCaps indices.
	capLogPixelsX      = 88
	capLogPixelsY      = 90
	capPhysicalWidth   = 110
	capPhysicalHeight  = 111
	capPhysicalOffsetX = 112
	capPhysicalOffsetY = 113

	biRGB        = 0
	dibRGBColors = 0
	srccopy      = 0x00CC0020
	halftone     = 4
)

type winBITMAPINFOHEADER struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type winBITMAPINFO struct {
	Header winBITMAPINFOHEADER
	Colors [1]uint32
}

type winDOCINFOW struct {
	CbSize         int32
	LpszDocName    *uint16
	LpszOutputFile *uint16
	LpszDatatype   *uint16
	FwType         uint32
}

var (
	pdfiumOnce sync.Once
	pdfiumPool pdfium.Pool
	pdfiumErr  error

	// PDFium is limited to one live worker. This both bounds memory and keeps
	// GDI page submission serialized so independent PDF jobs cannot overlap
	// on the same renderer/print pipeline.
	//
	// The slot is a channel, not a sync.Mutex, so a cancelled job refuses to
	// wait behind the holder: Lock would block past the SCM stop bound even
	// when ctx is already done, while the select below fails fast.
	embeddedPDFPrintSlot = make(chan struct{}, 1)

	modGDI32              = windows.NewLazySystemDLL("gdi32.dll")
	procCreateDCW         = modGDI32.NewProc("CreateDCW")
	procDeleteDC          = modGDI32.NewProc("DeleteDC")
	procGetDeviceCaps     = modGDI32.NewProc("GetDeviceCaps")
	procStartDocW         = modGDI32.NewProc("StartDocW")
	procEndDoc            = modGDI32.NewProc("EndDoc")
	procAbortDoc          = modGDI32.NewProc("AbortDoc")
	procStartPage         = modGDI32.NewProc("StartPage")
	procEndPage           = modGDI32.NewProc("EndPage")
	procStretchDIBits     = modGDI32.NewProc("StretchDIBits")
	procSetStretchBltMode = modGDI32.NewProc("SetStretchBltMode")
	procSetBrushOrgEx     = modGDI32.NewProc("SetBrushOrgEx")
)

func getPDFiumPool() (pdfium.Pool, error) {
	pdfiumOnce.Do(func() {
		// The pinned PDFium WASM uses exception handling for setjmp/longjmp.
		// Custom runtime configs must retain that upstream-required feature.
		runtimeConfig := wazero.NewRuntimeConfig().
			WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
			WithCloseOnContextDone(true)
		pdfiumPool, pdfiumErr = webassembly.Init(webassembly.Config{
			MinIdle:       0,
			MaxIdle:       1,
			MaxTotal:      1,
			ReuseWorkers:  true,
			RuntimeConfig: runtimeConfig,
			FSConfig:      wazero.NewFSConfig(),
			// The Agent runs as a headless Windows Service without reliable
			// standard handles. go-pdfium defaults nil writers to os.Stdout/
			// os.Stderr; wazero then fails to instantiate its WASM worker
			// with GetFileType /dev/stdout: The handle is invalid.
			// PDFium results/errors use the API, never a process console.
			Stdout: io.Discard,
			Stderr: io.Discard,
		})
	})
	return pdfiumPool, pdfiumErr
}

func openPrinterDC(printerName string, mode []byte) (uintptr, error) {
	if len(mode) == 0 {
		return 0, fmt.Errorf("missing validated PDF paper settings")
	}
	driver, err := windows.UTF16PtrFromString("WINSPOOL")
	if err != nil {
		return 0, fmt.Errorf("encode WINSPOOL driver name: %w", err)
	}
	device, err := windows.UTF16PtrFromString(printerName)
	if err != nil {
		return 0, fmt.Errorf("encode printer name: %w", err)
	}
	hdc, _, callErr := procCreateDCW.Call(
		uintptr(unsafe.Pointer(driver)),
		uintptr(unsafe.Pointer(device)),
		0,
		uintptr(unsafe.Pointer(&mode[0])),
	)
	if hdc == 0 {
		return 0, fmt.Errorf("CreateDCW(%q) failed: %w", printerName, callErr)
	}
	return hdc, nil
}

func deviceCaps(hdc uintptr, index int) int {
	ret, _, _ := procGetDeviceCaps.Call(hdc, uintptr(index))
	return int(int32(ret))
}

func startGDIPrint(hdc uintptr, jobID, printerName string) (uint32, error) {
	title := "YaseirAgent PDF"
	if jobID != "" {
		title += " " + jobID
	}
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return 0, fmt.Errorf("encode print document name: %w", err)
	}
	info := winDOCINFOW{
		CbSize:      int32(unsafe.Sizeof(winDOCINFOW{})),
		LpszDocName: titlePtr,
	}
	ret, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&info)))
	if int32(ret) <= 0 {
		return 0, fmt.Errorf("StartDocW(%q) failed: %w", printerName, callErr)
	}
	return uint32(ret), nil
}

func endGDIPrint(hdc uintptr) error {
	ret, _, callErr := procEndDoc.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("EndDoc failed: %w", callErr)
	}
	return nil
}

func abortGDIPrint(hdc uintptr) error {
	ret, _, callErr := procAbortDoc.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("AbortDoc failed: %w", callErr)
	}
	return nil
}

func startGDIPage(hdc uintptr) error {
	ret, _, callErr := procStartPage.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("StartPage failed: %w", callErr)
	}
	return nil
}

func endGDIPage(hdc uintptr) error {
	ret, _, callErr := procEndPage.Call(hdc)
	if int32(ret) <= 0 {
		return fmt.Errorf("EndPage failed: %w", callErr)
	}
	return nil
}

func renderBounds(printableWidth, printableHeight int) (int, int, error) {
	if printableWidth <= 0 || printableHeight <= 0 {
		return 0, 0, fmt.Errorf("printer reported invalid printable area %dx%d", printableWidth, printableHeight)
	}
	maxW, maxH := printableWidth, printableHeight
	area := int64(maxW) * int64(maxH)
	if area > maxPDFRenderPixels {
		scale := math.Sqrt(float64(maxPDFRenderPixels) / float64(area))
		maxW = max(1, int(float64(maxW)*scale))
		maxH = max(1, int(float64(maxH)*scale))
	}
	return maxW, maxH, nil
}

func rgbaToBGRAInPlace(src *image.RGBA) error {
	if src == nil {
		return fmt.Errorf("PDFium returned a nil bitmap")
	}
	width, height := src.Rect.Dx(), src.Rect.Dy()
	if width <= 0 || height <= 0 {
		return fmt.Errorf("PDFium returned an empty bitmap %dx%d", width, height)
	}
	if src.Stride != width*4 {
		return fmt.Errorf("PDFium returned unsupported bitmap stride %d for width %d", src.Stride, width)
	}
	for i := 0; i < len(src.Pix); i += 4 {
		r, g, b, a := src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3]
		if a != 255 {
			inv := uint32(255 - a)
			r = uint8((uint32(r)*uint32(a) + 255*inv) / 255)
			g = uint8((uint32(g)*uint32(a) + 255*inv) / 255)
			b = uint8((uint32(b)*uint32(a) + 255*inv) / 255)
		}
		src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = b, g, r, 0
	}
	return nil
}

// GDI starts at the printable-area origin. Negative hardware offsets place
// the PDF at the physical-sheet origin; capped raster pixels scale back to
// sheet device units so a memory limit does not change document dimensions.
func drawBitmapToPrinter(hdc uintptr, bitmap []byte, width, height, pageWidth, pageHeight, offsetX, offsetY int) error {
	if width <= 0 || height <= 0 || len(bitmap) != width*height*4 {
		return fmt.Errorf("invalid rendered bitmap %dx%d (%d bytes)", width, height, len(bitmap))
	}
	info := winBITMAPINFO{
		Header: winBITMAPINFOHEADER{
			BiSize:        uint32(unsafe.Sizeof(winBITMAPINFOHEADER{})),
			BiWidth:       int32(width),
			BiHeight:      -int32(height), // top-down DIB
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: biRGB,
			BiSizeImage:   uint32(len(bitmap)),
		},
	}

	x, y, destinationWidth, destinationHeight, err := pdfBitmapDestination(pageWidth, pageHeight, offsetX, offsetY)
	if err != nil {
		return err
	}

	previousMode, _, modeErr := procSetStretchBltMode.Call(hdc, halftone)
	if previousMode == 0 {
		return fmt.Errorf("SetStretchBltMode(HALFTONE) failed: %w", modeErr)
	}
	brushOK, _, brushErr := procSetBrushOrgEx.Call(hdc, 0, 0, 0)
	if brushOK == 0 {
		return fmt.Errorf("SetBrushOrgEx after HALFTONE failed: %w", brushErr)
	}
	ret, _, callErr := procStretchDIBits.Call(
		hdc,
		uintptr(x), uintptr(y), uintptr(destinationWidth), uintptr(destinationHeight),
		0, 0, uintptr(width), uintptr(height),
		uintptr(unsafe.Pointer(&bitmap[0])),
		uintptr(unsafe.Pointer(&info)),
		dibRGBColors,
		srccopy,
	)
	if int32(ret) <= 0 {
		return fmt.Errorf("StretchDIBits failed for %dx%d bitmap: %w", width, height, callErr)
	}
	return nil
}

func renderPageWithContext(ctx context.Context, instance pdfium.Pdfium, request *requests.RenderPageInPixels) (*image.RGBA, func(), error) {
	type outcome struct {
		rendered *responses.RenderPageInPixels
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		rendered, err := instance.RenderPageInPixels(request)
		done <- outcome{rendered: rendered, err: err}
	}()

	select {
	case result := <-done:
		if result.err != nil {
			return nil, nil, result.err
		}
		if result.rendered == nil {
			return nil, nil, fmt.Errorf("PDFium returned no render result")
		}
		return result.rendered.Result.Image, result.rendered.Cleanup, nil
	case <-ctx.Done():
		// Kill is the go-pdfium-supported way to interrupt an in-flight WASM
		// worker. The caller decides whether the physical outcome is already
		// ambiguous based on whether StartDocW has occurred.
		_ = instance.Kill()
		// If the render completed in the same instant as the cancellation,
		// its Cleanup would otherwise be orphaned in the buffered channel:
		// the bitmap was never handed out, so release it here.
		select {
		case result := <-done:
			if result.rendered != nil {
				result.rendered.Cleanup()
			}
		default:
		}
		return nil, nil, ctx.Err()
	}
}

// platformPrintPDF reads the generated temporary PDF file and submits it to
// the Windows GDI print pipeline rendered via embedded PDFium.
func platformPrintPDF(ctx context.Context, printerName, pdfPath string) error {
	_, err := platformPrintPDFWithJobID(ctx, printerName, pdfPath)
	return err
}

func platformPrintPDFWithJobID(ctx context.Context, printerName, pdfPath string) (string, error) {
	return platformPrintPDFWithJobIDObserved(ctx, printerName, pdfPath, nil)
}

// platformPrintPDFWithJobIDObserved is the production result path used by the
// Windows spooler backend when the caller must learn StartDocW's job identity
// before the rest of the synchronous GDI session finishes. onJobID runs in the
// GDI worker goroutine immediately after StartDocW succeeds; it must be fast
// and must not touch the HDC.
func platformPrintPDFWithJobIDObserved(ctx context.Context, printerName, pdfPath string, onJobID func(uint32)) (string, error) {
	data, err := os.ReadFile(pdfPath)
	if err != nil {
		return "", fmt.Errorf("read PDF file %q: %w", pdfPath, err)
	}
	var spoolerJobID uint32
	printErr := renderAndPrintPDFWithPDFiumResultObserved(ctx, printerName, data, &spoolerJobID, onJobID)
	jobID := ""
	if spoolerJobID != 0 {
		jobID = strconv.FormatUint(uint64(spoolerJobID), 10)
	}
	return jobID, printErr
}

func renderAndPrintPDFWithPDFiumResultObserved(ctx context.Context, printerName string, data []byte, spoolerJobID *uint32, onJobID func(uint32)) (retErr error) {
	pipelineStarted := time.Now()
	// One monotonic execution duration, not proof of physical paper output.
	defer func() {
		log.Printf("print.trace pdf_pipeline latency_ms=%d success=%t", time.Since(pipelineStarted).Milliseconds(), retErr == nil)
	}()
	// Ctx-aware acquisition: a job that is already cancelled (or a service
	// stop racing a long first render) must not block on the holder past
	// the SCM stop bound. The holder checks ctx per page, so the wait is
	// still bounded by one in-flight job, never indefinite.
	workerWaitStarted := time.Now()
	select {
	case embeddedPDFPrintSlot <- struct{}{}:
		defer func() { <-embeddedPDFPrintSlot }()
	case <-ctx.Done():
		return ctx.Err()
	}
	log.Printf("print.trace pdf_worker_wait latency_ms=%d", time.Since(workerWaitStarted).Milliseconds())

	if err := ValidatePDFPrinterName(printerName); err != nil {
		return err
	}
	if err := ValidatePDF(data); err != nil {
		return err
	}
	preflightStarted := time.Now()
	if err := runPreflightBounded(printerName, preflightTimeout, ctx, func() error {
		return dispatchPreFlightSpoolerCheck(printerName)
	}); err != nil {
		log.Printf("print.trace pdf_spooler_preflight latency_ms=%d success=false", time.Since(preflightStarted).Milliseconds())
		return fmt.Errorf("pre-flight spooler check failed: %w", err)
	}
	log.Printf("print.trace pdf_spooler_preflight latency_ms=%d success=true", time.Since(preflightStarted).Milliseconds())
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	acquireStarted := time.Now()
	pool, err := getPDFiumPool()
	if err != nil {
		log.Printf("print.trace pdf_renderer_acquire latency_ms=%d success=false", time.Since(acquireStarted).Milliseconds())
		return fmt.Errorf("initialize embedded PDFium renderer: %w", err)
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		log.Printf("print.trace pdf_renderer_acquire latency_ms=%d success=false", time.Since(acquireStarted).Milliseconds())
		return fmt.Errorf("acquire embedded PDFium worker: %w", err)
	}
	log.Printf("print.trace pdf_renderer_acquire latency_ms=%d success=true", time.Since(acquireStarted).Milliseconds())
	defer func() {
		if err := instance.Close(); err != nil {
			// The renderer worker is process-local cleanup. Once EndDoc has
			// succeeded, the Windows spooler has already accepted/finalized
			// the document; a cleanup failure must never downgrade that
			// submission into a definitely-not-printed failure. If printing
			// itself already failed, preserve that primary error unchanged.
			log.Printf("close embedded PDFium worker after print on %q: %v", printerName, err)
		}
	}()

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return fmt.Errorf("open PDF with embedded PDFium: %w", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document})

	pages, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return fmt.Errorf("read PDF page count: %w", err)
	}
	if pages.PageCount <= 0 {
		return fmt.Errorf("PDF contains no printable pages")
	}
	if pages.PageCount > maxPDFPages {
		return fmt.Errorf("PDF page count %d exceeds embedded renderer limit %d", pages.PageCount, maxPDFPages)
	}

	type pagePlan struct {
		width, height float64
		paper         pdfPaper
		mode          []byte
	}
	plans := make([]pagePlan, pages.PageCount)
	modes := make(map[pdfPaper][]byte)
	modeBytes := 0
	for pageIndex := range plans {
		if err := ctx.Err(); err != nil {
			return err
		}
		size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc.Document, Index: pageIndex})
		if err != nil || size == nil {
			return fmt.Errorf("read PDF page %d dimensions: %v", pageIndex+1, err)
		}
		paper, err := pdfPaperForPoints(size.Width, size.Height)
		if err != nil {
			return fmt.Errorf("PDF page %d: %w", pageIndex+1, err)
		}
		mode, ok := modes[paper]
		if !ok {
			mode, err = pdfPrinterDevMode(printerName, paper)
			if err != nil {
				return fmt.Errorf("configure PDF page %d paper: %w", pageIndex+1, err)
			}
			modeBytes += len(mode)
			if modeBytes > maxPDFDevModeBytes {
				return fmt.Errorf("PDF driver settings exceed the %d-byte document budget", maxPDFDevModeBytes)
			}
			modes[paper] = mode
		}
		plans[pageIndex] = pagePlan{size.Width, size.Height, paper, mode}
	}
	hdc, err := openPrinterDC(printerName, plans[0].mode)
	if err != nil {
		return err
	}
	defer func() { procDeleteDC.Call(hdc) }()

	// Prove all distinct forms are supported before StartDoc. A later mixed
	// page must not discover that the driver silently substituted default paper
	// after earlier pages already crossed the submission boundary.
	validated := make(map[pdfPaper]bool)
	for _, plan := range plans {
		if validated[plan.paper] {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		checkDC := hdc
		if plan.paper != plans[0].paper {
			checkDC, err = openPrinterDC(printerName, plan.mode)
			if err != nil {
				return err
			}
		}
		validationErr := validatePDFSheet(plan.width, plan.height, deviceCaps(checkDC, capPhysicalWidth), deviceCaps(checkDC, capPhysicalHeight), deviceCaps(checkDC, capLogPixelsX), deviceCaps(checkDC, capLogPixelsY))
		if checkDC != hdc {
			procDeleteDC.Call(checkDC)
		}
		if validationErr != nil {
			return validationErr
		}
		validated[plan.paper] = true
	}

	pageWidth, pageHeight, offsetX, offsetY, maxW, maxH := 0, 0, 0, 0, 0, 0
	pageBounds := func(index int) error {
		pageWidth, pageHeight = deviceCaps(hdc, capPhysicalWidth), deviceCaps(hdc, capPhysicalHeight)
		offsetX, offsetY = deviceCaps(hdc, capPhysicalOffsetX), deviceCaps(hdc, capPhysicalOffsetY)
		if _, _, _, _, err := pdfBitmapDestination(pageWidth, pageHeight, offsetX, offsetY); err != nil {
			return err
		}
		if err := validatePDFSheet(plans[index].width, plans[index].height, pageWidth, pageHeight, deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY)); err != nil {
			return err
		}
		var err error
		maxW, maxH, err = renderBounds(pageWidth, pageHeight)
		return err
	}
	if err := pageBounds(0); err != nil {
		return err
	}
	log.Printf("Embedded PDF print on %q: physical=%dx%d offset=%d,%d render-cap=%dx%d pages=%d", printerName, pageWidth, pageHeight, offsetX, offsetY, maxW, maxH, pages.PageCount)

	// Render the first page before StartDocW. A renderer failure here is a
	// deterministic pre-dispatch error, not an unknown physical outcome.
	firstPageStarted := time.Now()
	first, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: 0}},
		Width:  maxW,
		Height: maxH,
	})
	log.Printf("print.trace pdf_first_page_render latency_ms=%d success=%t", time.Since(firstPageStarted).Milliseconds(), err == nil)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("render PDF page 1/%d: %w", pages.PageCount, err)
	}
	if cleanup == nil {
		cleanup = func() {}
	}
	if err := rgbaToBGRAInPlace(first); err != nil {
		cleanup()
		return fmt.Errorf("prepare PDF page 1/%d bitmap: %w", pages.PageCount, err)
	}

	if err := runDispatchAdmission(ctx); err != nil {
		cleanup()
		return err
	}
	startDocumentStarted := time.Now()
	gdiJobID, err := startGDIPrint(hdc, "embedded-pdf", printerName)
	log.Printf("print.trace pdf_start_document latency_ms=%d success=%t", time.Since(startDocumentStarted).Milliseconds(), err == nil)
	if err != nil {
		cleanup()
		return err
	}
	if spoolerJobID != nil {
		*spoolerJobID = gdiJobID
	}
	if onJobID != nil {
		onJobID(gdiJobID)
	}
	docStarted := true
	docEnded := false
	cleanupFirst := true
	defer func() {
		if cleanupFirst {
			cleanup()
		}
		if docStarted && !docEnded {
			if abortErr := abortGDIPrint(hdc); abortErr != nil {
				log.Printf("PDF job abort failed for %q: %v", printerName, abortErr)
				if retErr == nil {
					retErr = markPDFDispatchUnknown(printerName, "could not abort the incomplete spool document", abortErr)
				}
			}
		}
	}()

	printPage := func(pageNumber int, img *image.RGBA) error {
		if err := ctx.Err(); err != nil {
			return markPDFDispatchUnknown(printerName, "cancelled before page admission", err)
		}
		if err := startGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not start page %d", pageNumber), err)
		}
		if err := drawBitmapToPrinter(hdc, img.Pix, img.Rect.Dx(), img.Rect.Dy(), pageWidth, pageHeight, offsetX, offsetY); err != nil {
			_ = endGDIPage(hdc)
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not render page %d to the printer", pageNumber), err)
		}
		if err := endGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not finalize page %d", pageNumber), err)
		}
		return nil
	}

	if err := printPage(1, first); err != nil {
		cleanup()
		cleanupFirst = false
		return err
	}
	cleanup()
	cleanupFirst = false

	for pageIndex := 1; pageIndex < pages.PageCount; pageIndex++ {
		select {
		case <-ctx.Done():
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("was cancelled before page %d", pageIndex+1), ctx.Err())
		default:
		}

		// ResetDC is called only between EndPage and the next StartPage.
		if plans[pageIndex].paper != plans[pageIndex-1].paper {
			reset, resetErr := resetPDFPrinterDC(hdc, plans[pageIndex].mode)
			if resetErr != nil {
				return markPDFDispatchUnknown(printerName, "could not configure the next page", resetErr)
			}
			hdc = reset
		}
		if err := pageBounds(pageIndex); err != nil {
			return markPDFDispatchUnknown(printerName, "driver substituted the next page geometry", err)
		}

		img, cleanupPage, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
			Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: pageIndex}},
			Width:  maxW,
			Height: maxH,
		})
		if err != nil {
			if ctx.Err() != nil {
				_ = instance.Kill()
				return markPDFDispatchUnknown(printerName, fmt.Sprintf("was cancelled while rendering page %d", pageIndex+1), ctx.Err())
			}
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("failed while rendering page %d", pageIndex+1), err)
		}
		if cleanupPage == nil {
			cleanupPage = func() {}
		}
		if err := rgbaToBGRAInPlace(img); err != nil {
			cleanupPage()
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("failed while preparing page %d", pageIndex+1), err)
		}
		if err := printPage(pageIndex+1, img); err != nil {
			cleanupPage()
			return err
		}
		cleanupPage()
	}

	endDocumentStarted := time.Now()
	if err := endGDIPrint(hdc); err != nil {
		log.Printf("print.trace pdf_end_document latency_ms=%d success=false", time.Since(endDocumentStarted).Milliseconds())
		return markPDFDispatchUnknown(printerName, "could not finalize the print job", err)
	}
	log.Printf("print.trace pdf_end_document latency_ms=%d success=true", time.Since(endDocumentStarted).Milliseconds())
	docEnded = true
	return nil
}

func markPDFDispatchUnknown(printerName, operation string, cause error) error {
	return MarkUnknown("embedded PDF print on %q %s after StartDocW; physical outcome is unknown: %v", printerName, operation, cause)
}
