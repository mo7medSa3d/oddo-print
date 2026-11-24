package printer

import "context"

// awaitPDFRenderResult transfers ownership of a render result exactly once.
// An unbuffered handoff makes the worker responsible for releasing a result
// when cancellation wins, including a result produced after the caller returns.
// Interrupt must request cancellation, not wait for the renderer to finish.
// Release must tolerate an empty result, because rendering can fail before an
// allocation. A successful handoff leaves cleanup entirely with the caller.
func awaitPDFRenderResult[T any](ctx context.Context, render func() (T, error), release func(T), interrupt func()) (T, error) {
	var zero T
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	type outcome struct {
		value T
		err   error
	}
	done := make(chan outcome)
	interruptComplete := make(chan struct{})
	go func() {
		value, err := render()
		select {
		case done <- outcome{value, err}:
			// The receiving caller now owns the result, including errors.
		case <-ctx.Done():
			// Do not call a bitmap cleanup API concurrently with Kill.
			<-interruptComplete
			if release != nil {
				release(value)
			}
		}
	}()

	select {
	case result := <-done:
		if result.err != nil {
			if release != nil {
				release(result.value)
			}
			return zero, result.err
		}
		return result.value, nil
	case <-ctx.Done():
		defer close(interruptComplete)
		if interrupt != nil {
			interrupt()
		}
		return zero, ctx.Err()
	}
}
