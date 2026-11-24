package printer

import (
	"context"
	"errors"
	"testing"
)

func TestPreCancelledWSDScanMustNotDeclareCompleteSource(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	found, err := discoverWSDPrinters(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled WSD must signal incomplete inventory; result=%v err=%v", found, err)
	}
	if len(found) != 0 {
		t.Fatalf("cancelled WSD yielded %d discovered printers", len(found))
	}
}
