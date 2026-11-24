//go:build windows

package printer

import (
	"context"
	"fmt"
	"image"
	"log"
	"os"
	"runtime"
	"strconv"
	"time"
	"unsafe"

	pdfium "github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/responses"
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
	maxPDFDevModeBytes = 8 * 1024 * 1024

	// GetDeviceCaps indices.
	capHorzRes         = 8
	capVertRes         = 10
	capRasterCaps      = 38
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

type generatedReceiptPDFKey struct{}

var (
	modGDI32              = windows.NewLazySystemDLL("gdi32.dll")
	procCreateDCW         = modGDI32.NewProc("CreateDCW")
	procDeleteDC          = modGDI32.NewProc("DeleteDC")
	procGetDeviceCaps     = modGDI32.NewProc("GetDeviceCaps")
	procGetClipBox        = modGDI32.NewProc("GetClipBox")
	procStartDocW         = modGDI32.NewProc("StartDocW")
	procEndDoc            = modGDI32.NewProc("EndDoc")
	procAbortDoc          = modGDI32.NewProc("AbortDoc")
	procStartPage         = modGDI32.NewProc("StartPage")
	procEndPage           = modGDI32.NewProc("EndPage")
	procStretchDIBits     = modGDI32.NewProc("StretchDIBits")
	procSetDIBitsToDevice = modGDI32.NewProc("SetDIBitsToDevice")
	procSetStretchBltMode = modGDI32.NewProc("SetStretchBltMode")
	procSetBrushOrgEx     = modGDI32.NewProc("SetBrushOrgEx")
)

// pinGDIPrintThread keeps the printer DC, any child memory DC, drawing and
// deferred AbortDoc/DeleteDC on one OS thread. The slot serializes PDF jobs,
// but without this guard Go can migrate the goroutine between native calls.
// A locked thread is released on every return path, including errors.
func pinGDIPrintThread() func() {
	runtime.LockOSThread()
	return runtime.UnlockOSThread
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
	var outputFilePtr *uint16
	outPath, outErr := resolveVirtualOutputPath(printerName, jobID)
	if outErr != nil {
		return 0, outErr
	}
	if outPath != "" {
		ptr, ptrErr := windows.UTF16PtrFromString(outPath)
		if ptrErr != nil {
			return 0, fmt.Errorf("encode virtual output path %q: %w", outPath, ptrErr)
		}
		outputFilePtr = ptr
		defer runtime.KeepAlive(outputFilePtr)
	}
	info := winDOCINFOW{
		CbSize:         int32(unsafe.Sizeof(winDOCINFOW{})),
		LpszDocName:    titlePtr,
		LpszOutputFile: outputFilePtr,
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

func rgbaToBGRAInPlace(src *image.RGBA) error {
	if src == nil {
		return fmt.Errorf("PDFium returned a nil bitmap")
	}
	width, height := src.Rect.Dx(), src.Rect.Dy()
	if width <= 0 || height <= 0 {
		return fmt.Errorf("PDFium returned an empty bitmap %dx%d", width, height)
	}
	if src.Stride != width*4 || len(src.Pix) != width*height*4 {
		return fmt.Errorf("PDFium returned unsupported bitmap layout: stride %d, %d bytes for %dx%d", src.Stride, len(src.Pix), width, height)
	}
	pix := src.Pix
	_ = pix[len(pix)-1]
	for i := 0; i < len(pix); i += 4 {
		p := pix[i : i+4 : i+4]
		a := p[3]
		if a == 255 {
			p[0], p[2], p[3] = p[2], p[0], 0
			continue
		}
		if a == 0 {
			p[0], p[1], p[2], p[3] = 255, 255, 255, 0
			continue
		}
		inv := uint32(255 - a)
		r := uint8((uint32(p[0])*uint32(a) + 255*inv) / 255)
		g := uint8((uint32(p[1])*uint32(a) + 255*inv) / 255)
		b := uint8((uint32(p[2])*uint32(a) + 255*inv) / 255)
		p[0], p[1], p[2], p[3] = b, g, r, 0
	}
	return nil
}

// Destination bounds were fitted to the actual printable area before drawing.
func drawBitmapToPrinter(hdc uintptr, bitmap []byte, width, height, destinationWidth, destinationHeight, x, y int) error {
	if width <= 0 || height <= 0 || len(bitmap) != width*height*4 {
		return fmt.Errorf("invalid rendered bitmap %dx%d (%d bytes)", width, height, len(bitmap))
	}
	if destinationWidth <= 0 || destinationHeight <= 0 || x < 0 || y < 0 {
		return fmt.Errorf("invalid fitted bitmap destination %d,%d %dx%d", x, y, destinationWidth, destinationHeight)
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

	// Direct copy requires driver support; select the existing stretch path
	// before submission when that capability is absent. Never replay a page.
	rasterCaps := deviceCaps(hdc, capRasterCaps)
	if _, supported := gdiBitmapCapabilities(rasterCaps, width != destinationWidth || height != destinationHeight); !supported {
		return gdiDeviceDiagnostic(hdc, fmt.Errorf("printer no longer advertises the required DIB transfer"))
	}
	directSupported := rasterCaps&rcDIBToDevice != 0
	err := transferGDIBitmap(width != destinationWidth || height != destinationHeight, directSupported, func() (int32, error) {
		ret, _, callErr := procSetDIBitsToDevice.Call(
			hdc,
			uintptr(x), uintptr(y), uintptr(width), uintptr(height),
			0, 0, 0, uintptr(height),
			uintptr(unsafe.Pointer(&bitmap[0])),
			uintptr(unsafe.Pointer(&info)),
			dibRGBColors,
		)
		return int32(ret), callErr
	}, func() (int32, error) {
		if err := setGDIHalftone(hdc); err != nil {
			return 0, err
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
		return int32(ret), callErr
	})
	if err != nil {
		return gdiDeviceDiagnostic(hdc, fmt.Errorf("GDI bitmap %dx%d to %d,%d %dx%d (32-bit BI_RGB, top-down) failed: %w", width, height, x, y, destinationWidth, destinationHeight, err))
	}
	return nil
}

func gdiDeviceDiagnostic(hdc uintptr, err error) error {
	var clip windows.Rect
	kind, _, _ := procGetClipBox.Call(hdc, uintptr(unsafe.Pointer(&clip)))
	// Service Session 0 differs from the interactive user's session.
	// Report only the session number (not the account or credentials) to
	// distinguish driver/service incompatibility from raster capability bugs.
	session := "unknown"
	var sessionID uint32
	if windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sessionID) == nil {
		session = strconv.FormatUint(uint64(sessionID), 10)
	}
	return fmt.Errorf("%w; raster_caps=%#x clip_kind=%d clip=(%d,%d)-(%d,%d) session_id=%s thread_id=%d", err,
		deviceCaps(hdc, capRasterCaps), int32(kind), clip.Left, clip.Top, clip.Right, clip.Bottom,
		session, windows.GetCurrentThreadId())
}

// pdfPageExtent is one page's size in PDF points as measured by PDFium.
type pdfPageExtent struct {
	width  float64
	height float64
}

// pdfDocumentHead is the product of the cancellable PDFium prepare step:
// an opened document, its page count, and every page's size.
type pdfDocumentHead struct {
	document  references.FPDF_DOCUMENT
	pageCount int
	pageSizes []pdfPageExtent
	close     func()
}

// openPDFDocumentHead opens a PDF and measures it (page count + page
// sizes) through awaitPDFRenderResult, the same cancellable handoff the
// page renderer uses. OpenDocument parses the whole file and can stall
// inside PDFium on a malformed document; invoked synchronously it would
// hold the single embedded PDFium worker hostage past the job context's
// deadline and wedge every later PDF job behind it. On success the
// caller owns the document and must call head.close(); on failure the
// helper has already closed whatever was opened. Page sizes are only
// measured when the count is inside the callers' accepted range; the
// callers' own count checks (and their exact error texts) run first.
func openPDFDocumentHead(ctx context.Context, instance pdfium.Pdfium, data []byte, killed *pdfiumKillTracker) (pdfDocumentHead, error) {
	release := func(r pdfDocumentHead) {
		if r.close != nil && !killed.killed {
			r.close()
		}
	}
	return awaitPDFRenderResult(ctx, func() (pdfDocumentHead, error) {
		var head pdfDocumentHead
		doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
		if err != nil {
			return head, fmt.Errorf("open PDF document: %w", err)
		}
		head.document = doc.Document
		head.close = func() { _, _ = instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) }
		count, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
		if err != nil || count == nil {
			return head, fmt.Errorf("read PDF page count: %v", err)
		}
		head.pageCount = count.PageCount
		if head.pageCount >= 1 && head.pageCount <= maxPDFPages {
			head.pageSizes = make([]pdfPageExtent, head.pageCount)
			for page := 0; page < head.pageCount; page++ {
				size, err := instance.FPDF_GetPageSizeByIndex(&requests.FPDF_GetPageSizeByIndex{Document: doc.Document, Index: page})
				if err != nil || size == nil {
					return head, fmt.Errorf("read PDF page %d dimensions: %v", page+1, err)
				}
				head.pageSizes[page] = pdfPageExtent{width: size.Width, height: size.Height}
			}
		}
		return head, nil
	}, release, func() { killed.kill(instance) })
}

func renderPageWithContext(ctx context.Context, instance pdfium.Pdfium, request *requests.RenderPageInPixels, killed *pdfiumKillTracker) (*image.RGBA, func(), error) {
	rendered, err := awaitPDFRenderResult(ctx,
		func() (*responses.RenderPageInPixels, error) { return instance.RenderPageInPixels(request) },
		func(result *responses.RenderPageInPixels) {
			if result != nil {
				result.Cleanup()
			}
		},
		func() { killed.kill(instance) },
	)
	if err != nil {
		return nil, nil, err
	}
	if rendered == nil {
		return nil, nil, fmt.Errorf("PDFium returned no render result")
	}
	// The caller owns successful results. Cancelled or failed handoffs are
	// cleaned by awaitPDFRenderResult, including a late renderer completion.
	return rendered.Result.Image, rendered.Cleanup, nil
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
// printPDFBytesWithResult executes an in-memory PDF renderer directly on
// doc.Data without round-tripping through a temporary file on disk, while
// preserving deadline, validation, and job-ID outcome wrapping.
func printPDFBytesWithResult(ctx context.Context, printerName string, doc Document, printFn func(ctx context.Context, printerName string, data []byte) (string, error)) (string, error) {
	if err := ValidatePDF(doc.Data); err != nil {
		return "", err
	}
	if err := ValidatePDFPrinterName(printerName); err != nil {
		return "", fmt.Errorf("refusing to print PDF: %w", err)
	}
	if printFn == nil {
		return "", fmt.Errorf("PDF print result function is nil")
	}
	printCtx, cancel := pdfPrintDeadlineContext(ctx)
	defer cancel()

	spoolerJobID, err := printFn(printCtx, printerName, doc.Data)
	return finishPrintPDFResult(printerName, doc.JobID, len(doc.Data), spoolerJobID, err)
}

func platformPrintPDFWithJobIDObserved(ctx context.Context, printerName, pdfPath string, onJobID func(uint32)) (string, error) {
	data, err := os.ReadFile(pdfPath)
	if err != nil {
		return "", fmt.Errorf("read PDF file %q: %w", pdfPath, err)
	}
	return platformPrintPDFBytesWithJobIDObserved(ctx, printerName, data, onJobID)
}

func platformPrintPDFBytesWithJobIDObserved(ctx context.Context, printerName string, data []byte, onJobID func(uint32)) (string, error) {
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
	pool, err := getPDFiumPoolWithContext(ctx)
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
	var killed pdfiumKillTracker
	defer func() {
		if err := killed.close(instance); err != nil {
			// The renderer worker is process-local cleanup. Once EndDoc has
			// succeeded, the Windows spooler has already accepted/finalized
			// the document; a cleanup failure must never downgrade that
			// submission into a definitely-not-printed failure. If printing
			// itself already failed, preserve that primary error unchanged.
			log.Printf("close embedded PDFium worker after print on %q: %v", printerName, err)
		}
	}()

	head, err := openPDFDocumentHead(ctx, instance, data, &killed)
	if err != nil {
		return fmt.Errorf("open PDF with embedded PDFium: %w", err)
	}
	defer head.close()
	doc := head.document

	if head.pageCount <= 0 {
		return fmt.Errorf("PDF contains no printable pages")
	}
	if head.pageCount > maxPDFPages {
		return fmt.Errorf("PDF page count %d exceeds embedded renderer limit %d", head.pageCount, maxPDFPages)
	}
	receipt, _ := ctx.Value(generatedReceiptPDFKey{}).(bool)
	imageGeometry, _ := ctx.Value(imageGeometryKey{}).(*Geometry)
	if receipt && head.pageCount != 1 {
		return fmt.Errorf("generated receipt PDF must contain exactly one page")
	}
	type pagePlan struct {
		pdfPagePlan
		paper       pdfPaper
		mode        []byte
		sourceIndex int
	}
	plans := make([]pagePlan, head.pageCount)
	modes := make(map[pdfPaper][]byte)
	var currentMode []byte
	currentModeCounted := false
	modeBytes := 0
	for pageIndex := range plans {
		if err := ctx.Err(); err != nil {
			return err
		}
		size := head.pageSizes[pageIndex]
		if err := validatePDFPageDimensions(size.width, size.height); err != nil {
			return fmt.Errorf("PDF page %d: %w", pageIndex+1, err)
		}
		paper, paperErr := pdfPaperForPoints(size.width, size.height)
		mode, ok := modes[paper]
		if !ok {
			var usedCurrent bool
			mode, usedCurrent, err = selectPDFPaperMode(func() ([]byte, error) {
				// Profiled images retain the driver's selected physical form;
				// variable receipt height is divided into pages, not fit to height.
				if imageGeometry != nil {
					return nil, fmt.Errorf("use measured current driver form for image")
				}
				// A valid source need not fit DEVMODE's signed-short form limits.
				if paperErr != nil {
					return nil, paperErr
				}
				return pdfPrinterDevMode(printerName, paper)
			}, func() ([]byte, error) {
				if currentMode == nil {
					var currentErr error
					currentMode, currentErr = pdfPrinterCurrentDevMode(printerName)
					return currentMode, currentErr
				}
				return currentMode, nil
			})
			if err != nil {
				return fmt.Errorf("configure PDF page %d paper: %w", pageIndex+1, err)
			}
			if usedCurrent {
				log.Printf("PDF page %d on %q will fit the selected driver's current paper before submission", pageIndex+1, printerName)
			}
			if !usedCurrent || !currentModeCounted {
				modeBytes += len(mode)
				currentModeCounted = currentModeCounted || usedCurrent
			}
			if modeBytes > maxPDFDevModeBytes {
				return fmt.Errorf("PDF driver settings exceed the %d-byte document budget", maxPDFDevModeBytes)
			}
			modes[paper] = mode
		}
		plan := pagePlan{pdfPagePlan: pdfPagePlan{width: size.width, height: size.height}, paper: paper, mode: mode, sourceIndex: pageIndex}
		if receipt {
			plan.crop, err = receiptPDFCrop(instance, requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: pageIndex}}, size.width, size.height)
			if err != nil {
				return fmt.Errorf("prepare generated receipt page %d before submission: %w", pageIndex+1, err)
			}
		}
		plans[pageIndex] = plan
	}
	// Do not migrate the live Win32 printer DC across OS threads while the
	// service renders or waits for PDFium. DeleteDC/AbortDoc defers run before
	// this unlock because Go runs defers in last-in-first-out order.
	unlockGDIThread := pinGDIPrintThread()
	defer unlockGDIThread()
	hdc, err := openPrinterDC(printerName, plans[0].mode)
	if err != nil {
		return err
	}
	defer func() { procDeleteDC.Call(hdc) }()

	if imageGeometry != nil {
		if err := checkImageDeviceGeometry(imageGeometry, deviceCaps(hdc, capPhysicalWidth), deviceCaps(hdc, capPhysicalHeight),
			deviceCaps(hdc, capHorzRes), deviceCaps(hdc, capVertRes), deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY),
			deviceCaps(hdc, capPhysicalOffsetX), deviceCaps(hdc, capPhysicalOffsetY)); err != nil {
			return err
		}
	}

	// Validate and paginate every actual printable form before StartDoc. Long
	// receipts retain their width and use multiple pages in one spool document;
	// they never become an unreadably thin image to fit a fixed form's height.
	expandedPlans := make([]pagePlan, 0, len(plans))
	for pageIndex, plan := range plans {
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
		physicalW, physicalH := deviceCaps(checkDC, capPhysicalWidth), deviceCaps(checkDC, capPhysicalHeight)
		dpiX, dpiY := deviceCaps(checkDC, capLogPixelsX), deviceCaps(checkDC, capLogPixelsY)
		segments, validationErr := plan.paginate(physicalW, physicalH,
			deviceCaps(checkDC, capHorzRes), deviceCaps(checkDC, capVertRes), dpiX, dpiY,
			deviceCaps(checkDC, capPhysicalOffsetX), deviceCaps(checkDC, capPhysicalOffsetY))
		if receiptJPEG, ok := ctx.Value(generatedReceiptJPEGKey{}).([]byte); ok && validationErr == nil {
			segments, validationErr = plan.paginateReceiptJPEG(receiptJPEG, physicalW, physicalH,
				deviceCaps(checkDC, capHorzRes), deviceCaps(checkDC, capVertRes), dpiX, dpiY,
				deviceCaps(checkDC, capPhysicalOffsetX), deviceCaps(checkDC, capPhysicalOffsetY))
		}
		if validationErr != nil {
			validationErr = pdfSheetDiagnostic(validationErr, pageIndex+1, true, plan.width, plan.height,
				physicalW, physicalH, deviceCaps(checkDC, capHorzRes), deviceCaps(checkDC, capVertRes),
				dpiX, dpiY, deviceCaps(checkDC, capPhysicalOffsetX), deviceCaps(checkDC, capPhysicalOffsetY))
		} else if mismatch := validatePDFSheet(plan.width, plan.height, physicalW, physicalH, dpiX, dpiY); mismatch != nil {
			log.Printf("PDF page %d on %q will fit the actual driver printable area before submission: %v", pageIndex+1, printerName, mismatch)
		}
		if checkDC != hdc {
			procDeleteDC.Call(checkDC)
		}
		if validationErr != nil {
			return validationErr
		}
		if len(expandedPlans)+len(segments) > maxPDFPages {
			return fmt.Errorf("paginated document exceeds the %d-page embedded renderer limit", maxPDFPages)
		}
		for _, segment := range segments {
			part := plan
			part.pdfPagePlan = segment
			expandedPlans = append(expandedPlans, part)
		}
	}
	plans = expandedPlans

	pageWidth, pageHeight, offsetX, offsetY, maxW, maxH := 0, 0, 0, 0, 0, 0
	destinationX, destinationY, destinationW, destinationH := 0, 0, 0, 0
	pageBounds := func(index int) error {
		pageWidth, pageHeight = deviceCaps(hdc, capPhysicalWidth), deviceCaps(hdc, capPhysicalHeight)
		offsetX, offsetY = deviceCaps(hdc, capPhysicalOffsetX), deviceCaps(hdc, capPhysicalOffsetY)
		dpiX, dpiY := deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY)
		var err error
		destinationX, destinationY, destinationW, destinationH, err = plans[index].printableDestination(
			pageWidth, pageHeight, deviceCaps(hdc, capHorzRes), deviceCaps(hdc, capVertRes), dpiX, dpiY, offsetX, offsetY)
		if err != nil {
			return pdfSheetDiagnostic(err, index+1, index == 0, plans[index].width, plans[index].height,
				pageWidth, pageHeight, deviceCaps(hdc, capHorzRes), deviceCaps(hdc, capVertRes), dpiX, dpiY, offsetX, offsetY)
		}
		maxW, maxH, err = renderBoundsForDPI(destinationW, destinationH, dpiX, dpiY)
		return err
	}
	if err := pageBounds(0); err != nil {
		return err
	}
	log.Printf("Embedded PDF print on %q: source=%.2fx%.2fpt crop=%+v physical=%dx%d printable=%dx%d dpi=%dx%d offset=%d,%d fitted=%d,%d %dx%d render-cap=%dx%d pages=%d", printerName,
		plans[0].width, plans[0].height, plans[0].crop, pageWidth, pageHeight, deviceCaps(hdc, capHorzRes), deviceCaps(hdc, capVertRes), deviceCaps(hdc, capLogPixelsX), deviceCaps(hdc, capLogPixelsY),
		offsetX, offsetY, destinationX, destinationY, destinationW, destinationH, maxW, maxH, len(plans))

	// Render the first page before StartDocW. A renderer failure here is a
	// deterministic pre-dispatch error, not an unknown physical outcome.
	firstPageStarted := time.Now()
	first, cleanup, err := renderPageWithContext(ctx, instance, &requests.RenderPageInPixels{
		Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: plans[0].sourceIndex}},
		Width:  maxW,
		Height: maxH,
		Crop:   plans[0].crop,
	}, &killed)
	log.Printf("print.trace pdf_first_page_render latency_ms=%d success=%t", time.Since(firstPageStarted).Milliseconds(), err == nil)
	if err != nil {
		if ctx.Err() != nil {
			killed.kill(instance)
			return ctx.Err()
		}
		return fmt.Errorf("render PDF output page 1/%d: %w", len(plans), err)
	}
	if cleanup == nil {
		cleanup = func() {}
	}
	if err := rgbaToBGRAInPlace(first); err != nil {
		cleanup()
		return fmt.Errorf("prepare PDF output page 1/%d bitmap: %w", len(plans), err)
	}
	firstDraw, releaseBitmap, err := prepareGDIBitmap(hdc, first.Pix, first.Rect.Dx(), first.Rect.Dy(), destinationW, destinationH, destinationX, destinationY)
	if err != nil {
		cleanup()
		return fmt.Errorf("prepare PDF output page 1/%d for printer: %w", len(plans), err)
	}
	cleanupRender := cleanup
	cleanup = func() { releaseBitmap(); cleanupRender() }

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

	printPage := func(pageNumber int, draw func() error) error {
		if err := ctx.Err(); err != nil {
			return markPDFDispatchUnknown(printerName, "cancelled before page admission", err)
		}
		if err := startGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not start page %d", pageNumber), err)
		}
		if err := draw(); err != nil {
			_ = endGDIPage(hdc)
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not render page %d to the printer", pageNumber), err)
		}
		if err := endGDIPage(hdc); err != nil {
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("could not finalize page %d", pageNumber), err)
		}
		return nil
	}

	if err := printPage(1, firstDraw); err != nil {
		cleanup()
		cleanupFirst = false
		return err
	}
	cleanup()
	cleanupFirst = false

	for pageIndex := 1; pageIndex < len(plans); pageIndex++ {
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
			Page:   requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: plans[pageIndex].sourceIndex}},
			Width:  maxW,
			Height: maxH,
			Crop:   plans[pageIndex].crop,
		}, &killed)
		if err != nil {
			if ctx.Err() != nil {
				killed.kill(instance)
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
		draw, releaseBitmap, err := prepareGDIBitmap(hdc, img.Pix, img.Rect.Dx(), img.Rect.Dy(), destinationW, destinationH, destinationX, destinationY)
		if err != nil {
			cleanupPage()
			return markPDFDispatchUnknown(printerName, fmt.Sprintf("failed while preparing page %d for printer", pageIndex+1), err)
		}
		if err := printPage(pageIndex+1, draw); err != nil {
			releaseBitmap()
			cleanupPage()
			return err
		}
		releaseBitmap()
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
