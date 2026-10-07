package printer

import "fmt"

// A buffered work queue can accept every target before any probe finishes.
// Worker cancellation therefore invalidates completeness even if all targets
// were enqueued. Keep collected devices, but never publish a complete source.
func discoveryScanError(source string, queued, total int, contextErr error) error {
	if contextErr != nil {
		return fmt.Errorf("%s scan interrupted (%d of %d targets queued; probes may be incomplete): %w", source, queued, total, contextErr)
	}
	if queued != total {
		return fmt.Errorf("%s scan truncated: %d of %d targets queued", source, queued, total)
	}
	return nil
}
