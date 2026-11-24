package printer

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
)

func TestGDIBitmapCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		caps                    int
		resize, compatible, dib bool
	}{
		{"no raster operations", 0, false, false, false},
		{"direct DIB", 0x0200, false, false, true},
		{"direct DIB cannot resize", 0x0200, true, false, false},
		{"stretch DIB at equal size", 0x2000, false, false, true},
		{"stretch DIB", 0x2000, true, false, true},
		{"native bitmap", 0x0081, false, true, false},
		{"native bitmap cannot resize", 0x0081, true, false, false},
		{"native stretch bitmap", 0x0880, true, true, false},
		{"native stretch at equal size", 0x0880, false, true, false},
		{"native needs DIB conversion", 0x0801, true, false, false},
		{"native and DIB", 0x2a81, true, true, true},
		{"reported POS80 and office capabilities, same size", 0x6e99, false, true, true},
		{"reported POS80 and office capabilities, resized", 0x6e99, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			compatible, dib := gdiBitmapCapabilities(tc.caps, tc.resize)
			if compatible != tc.compatible || dib != tc.dib {
				t.Fatalf("caps=%#x resize=%t: compatible=%t dib=%t", tc.caps, tc.resize, compatible, dib)
			}
		})
	}
}

func TestGDIFallbackKeepsPreparationAndTransferEvidence(t *testing.T) {
	prepareErr := errors.New("CreateCompatibleBitmap: driver memory allocation failed")
	transferErr := errors.New("StretchDIBits returned 0: transfer unconfirmed")
	got := wrapGDIFallbackFailure(prepareErr, transferErr)
	if !errors.Is(got, transferErr) || !strings.Contains(got.Error(), "CreateCompatibleBitmap") {
		t.Fatalf("both failure phases must survive: %v", got)
	}
	if got := wrapGDIFallbackFailure(prepareErr, nil); got != nil {
		t.Fatalf("successful DIB submission must not be downgraded: %v", got)
	}
	if got := wrapGDIFallbackFailure(nil, transferErr); !errors.Is(got, transferErr) {
		t.Fatalf("direct DIB failure changed: %v", got)
	}
}

func TestGDIBitmapTransferPreservesNativeDiagnostic(t *testing.T) {
	for _, code := range []syscall.Errno{0, 6, 87} {
		for _, resize := range []bool{false, true} {
			calls := 0
			transfer := func() (int32, error) { calls++; return 0, code }
			err := transferGDIBitmap(resize, true, transfer, transfer)
			want := fmt.Sprintf("win32_last_error=%d", code)
			if err == nil || calls != 1 || !strings.Contains(err.Error(), "returned 0") || !strings.Contains(err.Error(), want) {
				t.Fatalf("native diagnostic lost: code=%d resize=%t calls=%d err=%v", code, resize, calls, err)
			}
		}
	}

	// LazyProc.Call always returns an Errno, even when the primary result succeeds.
	for _, code := range []syscall.Errno{0, 87} {
		transfer := func() (int32, error) { return 42, code }
		if err := transferGDIBitmap(false, true, transfer, transfer); err != nil {
			t.Fatalf("successful drawing rejected by last-error diagnostic: %v", err)
		}
	}
}

func TestGDIBitmapTransferChoosesOneSubmission(t *testing.T) {
	for _, test := range []struct {
		name          string
		resize        bool
		directSupport bool
		wantStretch   bool
	}{
		{"equal size with direct support", false, true, false},
		{"equal size without direct support", false, false, true},
		{"resize with direct support", true, true, true},
		{"resize without direct support", true, false, true},
	} {
		directCalls, stretchCalls := 0, 0
		err := transferGDIBitmap(test.resize, test.directSupport, func() (int32, error) {
			directCalls++
			return 1631, nil
		}, func() (int32, error) {
			stretchCalls++
			return 1631, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if (!test.wantStretch && (directCalls != 1 || stretchCalls != 0)) ||
			(test.wantStretch && (directCalls != 0 || stretchCalls != 1)) {
			t.Fatalf("%s sent direct=%d stretch=%d submissions", test.name, directCalls, stretchCalls)
		}
	}
}

func TestGDIBitmapTransferAcceptsSignedScanlinesAndRejectsFailure(t *testing.T) {
	for _, scanlines := range []int32{1631, -1631, 0, -1} {
		calls := 0
		err := transferGDIBitmap(true, true, func() (int32, error) {
			t.Fatal("a failed stretch must never retry through another drawing API")
			return 1, nil
		}, func() (int32, error) {
			calls++
			return scanlines, nil
		})
		wantError := scanlines == 0 || scanlines == -1
		if (err != nil) != wantError || calls != 1 {
			t.Fatalf("scanlines=%d: err=%v calls=%d", scanlines, err, calls)
		}
		if err != nil && !strings.Contains(err.Error(), "StretchDIBits returned") {
			t.Fatalf("missing authoritative GDI return value: %v", err)
		}
	}
}

func TestGDIBitmapTransferPreservesPreparationFailure(t *testing.T) {
	want := errors.New("HALFTONE setup failed")
	err := transferGDIBitmap(true, true, func() (int32, error) {
		t.Fatal("preparation failure must not trigger another submission")
		return 1, nil
	}, func() (int32, error) { return 0, want })
	if !errors.Is(err, want) {
		t.Fatalf("drawing preparation failure lost: %v", err)
	}
}

func TestGDIBitmapDirectFailureNeverFallsBack(t *testing.T) {
	for _, scanlines := range []int32{0, -1, -1631} {
		calls := 0
		err := transferGDIBitmap(false, true, func() (int32, error) {
			calls++
			return scanlines, nil
		}, func() (int32, error) {
			t.Fatal("a failed direct drawing must not replay through StretchDIBits")
			return 1, nil
		})
		if err == nil || calls != 1 || !strings.Contains(err.Error(), "SetDIBitsToDevice returned") {
			t.Fatalf("direct scanlines=%d: err=%v calls=%d", scanlines, err, calls)
		}
	}
}
