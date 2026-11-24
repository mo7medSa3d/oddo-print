package printer

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestIPPRasterPreparationTriesAdvertisedJPEGAfterPWGPreparationFailure(t *testing.T) {
	var pwg, jpeg int
	data, format, err := prepareIPPRasterDocument(context.Background(), []string{"image/pwg-raster", "image/jpeg"},
		func() ([]byte, error) { pwg++; return nil, errors.New("unsupported advertised PWG color mode") },
		func() ([]byte, error) { jpeg++; return []byte("prepared JPEG"), nil })
	if err != nil || format != "image/jpeg" || !bytes.Equal(data, []byte("prepared JPEG")) || pwg != 1 || jpeg != 1 {
		t.Fatalf("usable JPEG was not selected before submission: format=%q err=%v pwg=%d jpeg=%d", format, err, pwg, jpeg)
	}
}

func TestIPPRasterPreparationDoesNotRenderUnadvertisedFormats(t *testing.T) {
	failure := errors.New("PWG unsupported")
	_, _, err := prepareIPPRasterDocument(context.Background(), []string{"image/pwg-raster"},
		func() ([]byte, error) { return nil, failure },
		func() ([]byte, error) { t.Fatal("unadvertised JPEG renderer was called"); return nil, nil })
	if !errors.Is(err, failure) {
		t.Fatalf("missing preparation failure: %v", err)
	}
}

func TestIPPRasterPreparationPreservesPreferredPWG(t *testing.T) {
	data, format, err := prepareIPPRasterDocument(context.Background(), []string{"image/pwg-raster", "image/jpeg"},
		func() ([]byte, error) { return []byte("RaS2"), nil },
		func() ([]byte, error) { t.Fatal("successful PWG should not render JPEG"); return nil, nil })
	if err != nil || format != "image/pwg-raster" || string(data) != "RaS2" {
		t.Fatalf("preferred PWG changed: %q %s %v", data, format, err)
	}
}

func TestIPPRasterPreparationStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, _, err := prepareIPPRasterDocument(ctx, []string{"image/pwg-raster", "image/jpeg"},
		func() ([]byte, error) { cancel(); return nil, errors.New("renderer interrupted") },
		func() ([]byte, error) { t.Fatal("cancelled request must not start fallback"); return nil, nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation must stop conversion: %v", err)
	}
}

func TestIPPRasterPreparationKeepsBothFailures(t *testing.T) {
	pwgErr, jpegErr := errors.New("PWG unsupported"), errors.New("JPEG needs one page")
	_, _, err := prepareIPPRasterDocument(context.Background(), []string{"image/pwg-raster", "image/jpeg"},
		func() ([]byte, error) { return nil, pwgErr }, func() ([]byte, error) { return nil, jpegErr })
	if !errors.Is(err, pwgErr) || !errors.Is(err, jpegErr) {
		t.Fatalf("conversion evidence lost: %v", err)
	}
}

func TestIPPRasterPreparationRejectsEmptySuccess(t *testing.T) {
	data, format, err := prepareIPPRasterDocument(context.Background(), []string{"image/jpeg"}, nil,
		func() ([]byte, error) { return nil, nil })
	if err == nil || data != nil || format != "" || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty document admitted: %q %q %v", data, format, err)
	}
}
