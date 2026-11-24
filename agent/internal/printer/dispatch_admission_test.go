package printer

import (
	"context"
	"errors"
	"testing"
)

func TestDispatchAdmissionAfterPreparationRefusesExpiredJob(t *testing.T) {
	expired := errors.New("Gateway refused expired job")
	prepared, documentStarted := false, false
	ctx := WithDispatchAdmission(context.Background(), func(context.Context) error {
		if !prepared {
			t.Fatal("admission requested before preparation")
		}
		return expired
	})
	prepared = true // driver/render/slot wait has completed
	if err := runDispatchAdmission(ctx); err == nil {
		documentStarted = true
	} else if !errors.Is(err, expired) {
		t.Fatal(err)
	}
	if documentStarted {
		t.Fatal("refused job reached physical dispatch")
	}
}

func TestDispatchAdmissionChecksCancellationBeforeAndAfterAcknowledgement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ctx = WithDispatchAdmission(ctx, func(context.Context) error { cancel(); return nil })
	if !errors.Is(runDispatchAdmission(ctx), context.Canceled) {
		t.Fatal("cancellation racing admission permitted dispatch")
	}
	called := false
	ctx = WithDispatchAdmission(ctx, func(context.Context) error { called = true; return nil })
	if !errors.Is(runDispatchAdmission(ctx), context.Canceled) || called {
		t.Fatal("already cancelled dispatch contacted Gateway")
	}
	if err := runDispatchAdmission(context.Background()); err != nil {
		t.Fatalf("local diagnostic was refused: %v", err)
	}
}
