//go:build windows

package printer

import (
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestGDIPrintThreadRemainsPinnedAcrossSchedulerYields(t *testing.T) {
	unlock := pinGDIPrintThread()
	defer unlock()
	originalThread := windows.GetCurrentThreadId()
	for i := 0; i < 128; i++ {
		runtime.Gosched()
		if got := windows.GetCurrentThreadId(); got != originalThread {
			t.Fatalf("GDI thread migrated from %d to %d", originalThread, got)
		}
	}
}

func TestGDIBitmapNativeFailureDiagnostic(t *testing.T) {
	err := drawBitmapToPrinter(0, make([]byte, 4), 1, 1, 1, 1, 0, 0)
	if err == nil || !strings.Contains(err.Error(), "raster_caps=0x0 clip_kind=0") || !strings.Contains(err.Error(), "session_id=") || !strings.Contains(err.Error(), "thread_id=") {
		t.Fatalf("invalid DC failure lacks native geometry context: %v", err)
	}
}

// Exercise the real Win32 ABI and pixels without submitting a print job.
func TestGDIBitmapNativeTransfer(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for _, tc := range []struct {
		name            string
		width, height   int
		destW, destH, y int
	}{
		{"direct", 17, 11, 17, 11, 0},
		{"stretch", 17, 11, 34, 22, 3},
		{"POS80", 576, 853, 576, 853, 0},
		{"POS80 long form", 640, 828, 640, 828, 12677},
		{"office", 3516, 4550, 4800, 6211, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			createDC := modGDI32.NewProc("CreateCompatibleDC")
			createDIB := modGDI32.NewProc("CreateDIBSection")
			selectObject := modGDI32.NewProc("SelectObject")
			deleteObject := modGDI32.NewProc("DeleteObject")
			flush := modGDI32.NewProc("GdiFlush")
			hdc, _, err := createDC.Call(0)
			if hdc == 0 {
				t.Fatalf("CreateCompatibleDC: %v", err)
			}
			defer procDeleteDC.Call(hdc)
			info := winBITMAPINFO{Header: winBITMAPINFOHEADER{
				BiSize:  uint32(unsafe.Sizeof(winBITMAPINFOHEADER{})),
				BiWidth: int32(tc.destW), BiHeight: -int32(tc.y + tc.destH),
				BiPlanes: 1, BiBitCount: 32,
			}}
			var bits unsafe.Pointer
			hbmp, _, err := createDIB.Call(hdc, uintptr(unsafe.Pointer(&info)), dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
			if hbmp == 0 || bits == nil {
				t.Fatalf("CreateDIBSection: %v", err)
			}
			defer deleteObject.Call(hbmp)
			previous, _, err := selectObject.Call(hdc, hbmp)
			if previous == 0 || int32(previous) == -1 {
				t.Fatalf("SelectObject: %v", err)
			}
			defer selectObject.Call(hdc, previous)
			src := make([]byte, tc.width*tc.height*4)
			row := make([]byte, tc.width*4)
			// Distinct, large quadrants detect reversal and channel errors.
			for x := 0; x < tc.width; x++ {
				i := x * 4
				row[i], row[i+1], row[i+2] = 32, 64, byte(64+128*(x/(tc.width/2+1)))
			}
			for y := 0; y < tc.height; y++ {
				if y == tc.height/2+1 {
					for i := 1; i < len(row); i += 4 {
						row[i] = 192
					}
				}
				copy(src[y*len(row):], row)
			}
			out := unsafe.Slice((*byte)(bits), tc.destW*(tc.y+tc.destH)*4)
			for _, automatic := range []bool{false, true} {
				clear(out)
				if automatic {
					draw, release, err := prepareGDIBitmap(hdc, src, tc.width, tc.height, tc.destW, tc.destH, 0, tc.y)
					if err != nil {
						t.Fatal(err)
					}
					defer release()
					// A compatible bitmap must already own the complete converted pixels.
					clear(src)
					if err := draw(); err != nil {
						t.Fatal(err)
					}
				} else if err := drawBitmapToPrinter(hdc, src, tc.width, tc.height, tc.destW, tc.destH, 0, tc.y); err != nil {
					t.Fatal(err)
				}
				if ok, _, err := flush.Call(); ok == 0 {
					t.Fatalf("GdiFlush: %v", err)
				}
				for _, point := range [][2]int{
					{0, 0}, {tc.destW - 1, 0},
					{0, tc.destH - 1}, {tc.destW - 1, tc.destH - 1},
					{tc.destW / 4, tc.destH / 4}, {tc.destW * 3 / 4, tc.destH * 3 / 4},
				} {
					x, y := point[0], point[1]
					i := ((y+tc.y)*tc.destW + x) * 4
					wantG, wantR := byte(64+128*(y/(tc.destH/2+1))), byte(64+128*(x/(tc.destW/2+1)))
					if out[i] != 32 || out[i+1] != wantG || out[i+2] != wantR {
						t.Fatalf("automatic=%t pixel %d,%d = %v, want BGR %v", automatic, x, y, out[i:i+3], []byte{32, wantG, wantR})
					}
				}
			}
		})
	}
}

func TestGDIBitmapMetafileTransfer(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for _, destWidth := range []int{17, 34} {
		hdc, _, err := modGDI32.NewProc("CreateEnhMetaFileW").Call(0, 0, 0, 0)
		if hdc == 0 {
			t.Fatalf("CreateEnhMetaFileW: %v", err)
		}
		func() {
			defer func() {
				emf, _, err := modGDI32.NewProc("CloseEnhMetaFile").Call(hdc)
				if emf == 0 {
					t.Errorf("CloseEnhMetaFile: %v", err)
					return
				}
				modGDI32.NewProc("DeleteEnhMetaFile").Call(emf)
			}()
			if err := drawBitmapToPrinter(hdc, make([]byte, 17*11*4), 17, 11, destWidth, 11, 0, 0); err != nil {
				t.Errorf("metafile destination width %d: %v", destWidth, err)
			}
			draw, release, err := prepareGDIBitmap(hdc, make([]byte, 17*11*4), 17, 11, destWidth, 11, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			if err := draw(); err != nil {
				t.Errorf("automatic metafile destination width %d: %v", destWidth, err)
			}
		}()
	}
}

func TestGDIBitmapPreparationRejectsInvalidDeviceOrGeometry(t *testing.T) {
	for _, width := range []int{1, maxPDFRenderPixels + 1} {
		draw, release, err := prepareGDIBitmap(0, make([]byte, 4), width, 1, 1, 1, 0, 0)
		if err == nil || draw != nil || release != nil {
			t.Fatalf("invalid preparation admitted: width=%d err=%v", width, err)
		}
	}
}

func TestGDIBitmapMonochromeConversion(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hdc, _, err := procCreateCompatibleDC.Call(0)
	if hdc == 0 {
		t.Fatal(err)
	}
	defer procDeleteDC.Call(hdc)
	bmp, _, err := modGDI32.NewProc("CreateBitmap").Call(8, 8, 1, 1, 0)
	if bmp == 0 {
		t.Fatal(err)
	}
	defer procDeleteObject.Call(bmp)
	old, _, err := procSelectObject.Call(hdc, bmp)
	if old == 0 || int32(old) == -1 {
		t.Fatal(err)
	}
	defer procSelectObject.Call(hdc, old)
	src := make([]byte, 8*8*4)
	for i := 8 * 4 * 4; i < len(src); i += 4 {
		src[i], src[i+1], src[i+2] = 255, 255, 255
	}
	draw, release, err := prepareGDIBitmap(hdc, src, 8, 8, 8, 8, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	clear(src)
	if err := draw(); err != nil {
		t.Fatal(err)
	}
	for _, point := range []struct {
		y     int
		color uintptr
	}{{2, 0}, {6, 0xffffff}} {
		color, _, err := modGDI32.NewProc("GetPixel").Call(hdc, 2, uintptr(point.y))
		if color != point.color {
			t.Fatalf("row %d color=%#x want=%#x: %v", point.y, color, point.color, err)
		}
	}
}
