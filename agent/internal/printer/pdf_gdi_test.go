package printer

import (
	"errors"
	"strings"
	"testing"
)

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
