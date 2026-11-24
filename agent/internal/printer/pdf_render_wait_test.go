package printer

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestPDFRenderWaitReleasesLateResultAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, finish, released := make(chan struct{}), make(chan struct{}), make(chan int, 1)
	done := make(chan error, 1)
	var interruptions atomic.Int32
	go func() {
		_, err := awaitPDFRenderResult(ctx, func() (int, error) {
			close(entered)
			<-finish
			return 17, nil
		}, func(value int) { released <- value }, func() { interruptions.Add(1) })
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		close(finish)
		t.Fatal("caller waited for an uncooperative renderer")
	}
	close(finish)
	select {
	case value := <-released:
		if value != 17 {
			t.Fatalf("wrong released render: %d", value)
		}
	case <-time.After(time.Second):
		t.Fatal("render result completed after cancellation was orphaned without cleanup")
	}
	if interruptions.Load() != 1 {
		t.Fatalf("interruptions = %d", interruptions.Load())
	}
}

func TestPDFRenderWaitTransfersSuccessfulResultOwnership(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var releases, interruptions atomic.Int32
	value, err := awaitPDFRenderResult(ctx, func() (int, error) { return 23, nil },
		func(int) { releases.Add(1) }, func() { interruptions.Add(1) })
	cancel()
	if err != nil || value != 23 || releases.Load() != 0 || interruptions.Load() != 0 {
		t.Fatalf("successful render ownership changed: value=%d err=%v releases=%d interrupts=%d", value, err, releases.Load(), interruptions.Load())
	}
}

func TestPDFRenderWaitReleasesErrorResult(t *testing.T) {
	expected := errors.New("render failed after allocating result")
	var released int
	value, err := awaitPDFRenderResult(context.Background(), func() (int, error) { return 29, expected },
		func(value int) { released = value }, nil)
	if !errors.Is(err, expected) || value != 0 || released != 29 {
		t.Fatalf("failed render resource not released: value=%d err=%v released=%d", value, err, released)
	}
}

func TestPDFRenderWaitDoesNotStartCancelledWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	_, err := awaitPDFRenderResult(ctx, func() (int, error) { calls.Add(1); return 1, nil }, func(int) {}, func() {})
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("already-cancelled render started: calls=%d err=%v", calls.Load(), err)
	}
}

func TestPDFRenderWaitCancellationCompletionRaceOwnsCleanupExactlyOnce(t *testing.T) {
	for i := 0; i < 100; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		entered, complete := make(chan struct{}), make(chan struct{})
		cleaned := make(chan struct{}, 1)
		var releases atomic.Int32
		release := func(int) { releases.Add(1); cleaned <- struct{}{} }
		go func() { <-entered; close(complete); cancel() }()
		value, err := awaitPDFRenderResult(ctx, func() (int, error) {
			close(entered)
			<-complete
			return 37, nil
		}, release, func() {})
		if err == nil {
			if value != 37 {
				t.Fatalf("wrong successful result: %d", value)
			}
			release(value)
		} else if !errors.Is(err, context.Canceled) {
			t.Fatalf("wrong race result: %v", err)
		}
		select {
		case <-cleaned:
		case <-time.After(time.Second):
			t.Fatal("race lost render cleanup ownership")
		}
		if releases.Load() != 1 {
			t.Fatalf("result released %d times", releases.Load())
		}
		cancel()
	}
}

func TestPDFRenderWaitReleasesOnlyAfterInterruptCompletes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, finishRender := make(chan struct{}), make(chan struct{})
	interrupting, finishInterrupt := make(chan struct{}), make(chan struct{})
	released, done := make(chan struct{}, 1), make(chan error, 1)
	go func() {
		_, err := awaitPDFRenderResult(ctx, func() (int, error) {
			close(entered)
			<-finishRender
			return 1, nil
		}, func(int) { released <- struct{}{} }, func() {
			close(interrupting)
			<-finishInterrupt
		})
		done <- err
	}()
	<-entered
	cancel()
	<-interrupting
	close(finishRender)
	select {
	case <-released:
		close(finishInterrupt)
		t.Fatal("bitmap cleanup raced the renderer interrupt")
	case <-time.After(20 * time.Millisecond):
	}
	close(finishInterrupt)
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not run after interrupt")
	}
}
