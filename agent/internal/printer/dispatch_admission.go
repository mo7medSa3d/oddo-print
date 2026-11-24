package printer

import "context"

type dispatchAdmissionKey struct{}

// WithDispatchAdmission carries a fresh control-plane check to the actual
// transport boundary, after rendering, driver calls and backend-local waits.
// Local diagnostic calls without a Gateway job retain their existing behavior.
func WithDispatchAdmission(ctx context.Context, admit func(context.Context) error) context.Context {
	return context.WithValue(ctx, dispatchAdmissionKey{}, admit)
}

func runDispatchAdmission(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if admit, ok := ctx.Value(dispatchAdmissionKey{}).(func(context.Context) error); ok && admit != nil {
		if err := admit(ctx); err != nil {
			return err
		}
	}
	// Shutdown may race a successful HTTP acknowledgement. Check again before
	// allowing the backend to create a document or send its first print bytes.
	return ctx.Err()
}
