package printer

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

// prepareIPPRasterDocument selects a locally renderable, advertised format.
// This helper performs preparation only: neither callback may submit a print
// job. The caller sends exactly one Print-Job after this function succeeds;
// transmission errors must never re-enter format selection.
func prepareIPPRasterDocument(ctx context.Context, formats []string, renderPWG, renderJPEG func() ([]byte, error)) ([]byte, string, error) {
	var failures []error
	for _, candidate := range []struct {
		format string
		render func() ([]byte, error)
	}{
		{"image/pwg-raster", renderPWG},
		{"image/jpeg", renderJPEG},
	} {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		if !slices.Contains(formats, candidate.format) {
			continue
		}
		if candidate.render == nil {
			failures = append(failures, fmt.Errorf("%s renderer unavailable", candidate.format))
			continue
		}
		data, err := candidate.render()
		if cancelErr := ctx.Err(); cancelErr != nil {
			return nil, "", cancelErr
		}
		if err == nil && len(data) > 0 {
			return data, candidate.format, nil
		}
		if err == nil {
			err = fmt.Errorf("renderer returned an empty document")
		}
		failures = append(failures, fmt.Errorf("%s preparation failed: %w", candidate.format, err))
	}
	if len(failures) == 0 {
		return nil, "", fmt.Errorf("no supported raster format was advertised")
	}
	return nil, "", errors.Join(failures...)
}
