package printer

import (
	"context"
	"fmt"
	"sync"
)

type pdfiumWarmupFlight struct {
	done chan struct{}
	err  error
}

var pdfiumWarmupState struct {
	sync.Mutex
	ready  bool
	flight *pdfiumWarmupFlight
}

// awaitPDFiumWarmup bounds each live probe independently from a cold embedded
// module's compilation. There is at most one startup worker using the existing
// one-instance pool. Canceling a probe neither cancels nor poisons that shared
// initialization; no file or printer output is produced by warmup.
func awaitPDFiumWarmup(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	pdfiumWarmupState.Lock()
	if pdfiumWarmupState.ready {
		pdfiumWarmupState.Unlock()
		return nil
	}
	flight := pdfiumWarmupState.flight
	if flight == nil {
		flight = &pdfiumWarmupFlight{done: make(chan struct{})}
		pdfiumWarmupState.flight = flight
		go func() {
			// Borrowing/readiness uses the normal document budget. The pinned
			// library compiles synchronously with its pool-lifetime context,
			// so this is not a hard interruption deadline for CompileModule.
			// That initialization stays concurrency-bounded to this one flight;
			// individual probe waits remain strictly context-bounded below.
			warmCtx, cancel := context.WithTimeout(context.Background(), defaultPDFPrintTimeout)
			defer cancel()
			err := warmPDFiumInstance(warmCtx)
			pdfiumWarmupState.Lock()
			flight.err = err
			pdfiumWarmupState.ready = err == nil
			pdfiumWarmupState.flight = nil
			close(flight.done)
			pdfiumWarmupState.Unlock()
		}()
	}
	pdfiumWarmupState.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-flight.done:
		if flight.err != nil {
			return fmt.Errorf("initialize embedded PDFium worker: %w", flight.err)
		}
		return ctx.Err()
	}
}

func warmPDFiumInstance(ctx context.Context) error {
	// webassembly.Config.Context must outlive the shared pool. Supplying a
	// short probe/startup context to Init would poison future print workers.
	pool, err := getPDFiumPool()
	if err != nil {
		return err
	}
	instance, err := pool.GetInstanceWithContext(ctx)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		_ = instance.Kill()
		return err
	}
	return instance.Close()
}
