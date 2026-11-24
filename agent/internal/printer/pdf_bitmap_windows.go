//go:build windows

package printer

import (
	"fmt"
	"log"
	"syscall"
	"unsafe"
)

var (
	procCreateCompatibleDC     = modGDI32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = modGDI32.NewProc("CreateCompatibleBitmap")
	procSetDIBits              = modGDI32.NewProc("SetDIBits")
	procSelectObject           = modGDI32.NewProc("SelectObject")
	procDeleteObject           = modGDI32.NewProc("DeleteObject")
	procBitBlt                 = modGDI32.NewProc("BitBlt")
	procStretchBlt             = modGDI32.NewProc("StretchBlt")
)

// Preparation touches memory surfaces only; no printer drawing is retried.
func prepareGDIBitmap(hdc uintptr, bitmap []byte, width, height, destW, destH, x, y int) (func() error, func(), error) {
	if width <= 0 || height <= 0 || int64(width) > maxPDFRenderPixels/int64(height) || len(bitmap) != width*height*4 || destW <= 0 || destH <= 0 || x < 0 || y < 0 {
		return nil, nil, fmt.Errorf("invalid or oversized GDI bitmap geometry")
	}
	resize := width != destW || height != destH
	caps := deviceCaps(hdc, capRasterCaps)
	compatible, dib := gdiBitmapCapabilities(caps, resize)
	var compatiblePreparationErr error
	if compatible {
		draw, cleanup, err := prepareCompatibleGDIBitmap(hdc, bitmap, width, height, destW, destH, x, y, resize || caps&rcBitBlt == 0)
		if err == nil {
			log.Printf("print.trace gdi_bitmap backend=compatible raster_caps=%#x source=%dx%d target=%dx%d", caps, width, height, destW, destH)
			return draw, cleanup, nil
		}
		compatiblePreparationErr = err
		if !dib {
			return nil, nil, err
		}
		log.Printf("GDI compatible bitmap preparation failed before drawing; using advertised DIB support: %v", err)
	}
	if !dib {
		return nil, nil, fmt.Errorf("printer has no supported bitmap transfer for resize=%t (raster_caps=%#x)", resize, caps)
	}
	log.Printf("print.trace gdi_bitmap backend=dib raster_caps=%#x source=%dx%d target=%dx%d", caps, width, height, destW, destH)
	return func() error {
		return wrapGDIFallbackFailure(compatiblePreparationErr,
			drawBitmapToPrinter(hdc, bitmap, width, height, destW, destH, x, y))
	}, func() {}, nil
}

func prepareCompatibleGDIBitmap(hdc uintptr, bitmap []byte, width, height, destW, destH, x, y int, stretch bool) (draw func() error, release func(), retErr error) {
	memoryDC, _, callErr := procCreateCompatibleDC.Call(hdc)
	if memoryDC == 0 {
		return nil, nil, fmt.Errorf("CreateCompatibleDC failed: %v", callErr)
	}
	var handle, previous uintptr
	cleanup := func() {
		if previous != 0 {
			procSelectObject.Call(memoryDC, previous)
		}
		procDeleteDC.Call(memoryDC)
		if handle != 0 {
			procDeleteObject.Call(handle)
		}
	}
	defer func() {
		if retErr != nil {
			cleanup()
		}
	}()
	// Use the printer DC, not the memory DC's initial monochrome surface.
	handle, _, callErr = procCreateCompatibleBitmap.Call(hdc, uintptr(width), uintptr(height))
	if handle == 0 {
		return nil, nil, fmt.Errorf("CreateCompatibleBitmap %dx%d failed: %v", width, height, callErr)
	}
	info := winBITMAPINFO{Header: winBITMAPINFOHEADER{
		BiSize: uint32(unsafe.Sizeof(winBITMAPINFOHEADER{})), BiWidth: int32(width), BiHeight: -int32(height),
		BiPlanes: 1, BiBitCount: 32, BiCompression: biRGB, BiSizeImage: uint32(len(bitmap)),
	}}
	// SetDIBits requires that the target bitmap is not selected into a DC yet.
	lines, _, callErr := procSetDIBits.Call(hdc, handle, 0, uintptr(height), uintptr(unsafe.Pointer(&bitmap[0])), uintptr(unsafe.Pointer(&info)), dibRGBColors)
	if int32(lines) != int32(height) {
		return nil, nil, fmt.Errorf("SetDIBits prepared %d/%d scan lines: %v", int32(lines), height, callErr)
	}
	previous, _, callErr = procSelectObject.Call(memoryDC, handle)
	if previous == 0 || int32(previous) == -1 {
		previous = 0
		return nil, nil, fmt.Errorf("SelectObject for compatible bitmap failed: %v", callErr)
	}
	if stretch {
		if err := setGDIHalftone(hdc); err != nil {
			return nil, nil, err
		}
	}
	return func() error {
		api := "BitBlt"
		var ok uintptr
		var err error
		if stretch {
			api = "StretchBlt"
			ok, _, err = procStretchBlt.Call(hdc, uintptr(x), uintptr(y), uintptr(destW), uintptr(destH), memoryDC, 0, 0, uintptr(width), uintptr(height), srccopy)
		} else {
			ok, _, err = procBitBlt.Call(hdc, uintptr(x), uintptr(y), uintptr(width), uintptr(height), memoryDC, 0, 0, srccopy)
		}
		if ok == 0 {
			return gdiDeviceDiagnostic(hdc, fmt.Errorf("%s compatible bitmap %dx%d to %d,%d %dx%d returned 0; bitmap transfer is unconfirmed (win32_last_error=%d, diagnostic only)", api, width, height, x, y, destW, destH, err.(syscall.Errno)))
		}
		return nil
	}, cleanup, nil
}

func setGDIHalftone(hdc uintptr) error {
	mode, _, err := procSetStretchBltMode.Call(hdc, halftone)
	if mode == 0 {
		return fmt.Errorf("SetStretchBltMode(HALFTONE) failed: %w", err)
	}
	brush, _, err := procSetBrushOrgEx.Call(hdc, 0, 0, 0)
	if brush == 0 {
		return fmt.Errorf("SetBrushOrgEx after HALFTONE failed: %w", err)
	}
	return nil
}
