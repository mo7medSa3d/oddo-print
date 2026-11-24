package printer

import (
	"context"
	"errors"
	"testing"
)

func TestBufferedTargetsDoNotProveCompleteDiscovery(t *testing.T) {
	for _, source := range []string{"IPP TCP", "network TCP"} {
		if err := discoveryScanError(source, 254, 254, context.DeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s: queued-but-cancelled scan incorrectly complete: %v", source, err)
		}
		if err := discoveryScanError(source, 32, 254, nil); err == nil {
			t.Fatalf("%s: incomplete queue incorrectly complete", source)
		}
		if err := discoveryScanError(source, 254, 254, nil); err != nil {
			t.Fatalf("%s: completed scan rejected: %v", source, err)
		}
		if err := discoveryScanError(source, 0, 0, nil); err != nil {
			t.Fatalf("%s: healthy empty scan rejected: %v", source, err)
		}
	}
}
