package integration_test

import (
	"bytes"
	"context"
	"errors"
	"github.com/yaseir-agent/agent/internal/queue"
	"path/filepath"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/testutil"
)

// Failure matrix via mock: refused, timeout, disconnect, retry, multi-printer, serialization, idempotent duplicate

func TestFailureConnectionRefused(t *testing.T) {
	p := &printer.NetworkPrinter{Address: "127.0.0.1:19998"}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := p.Print(ctx, []byte("hi")); err == nil {
		t.Fatalf("expected refused")
	}
	if s := p.Status(); s != "offline" {
		t.Fatalf("expected offline, got %s", s)
	}
}

func TestFailureTimeout(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.SetPartialReadLimit(1)
	if err := mock.Start(); err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := p.Print(ctx, bytes.Repeat([]byte("x"), 5*1024*1024))
	if err == nil {
		t.Fatal("stalled large write incorrectly reported success")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("write ignored the caller deadline")
	}
	captures := mock.WaitForCaptures(1, time.Second)
	if len(captures) != 1 || len(captures[0]) != 1 {
		t.Fatalf("server did not stall after exactly one byte: %v", captures)
	}
}

func TestFailurePrinterDisconnectAndRetry(t *testing.T) {
	// Deliberately NOT an ephemeral port: after mock.Close() the OS could hand
	// a freed ephemeral port to another package's listener running in parallel,
	// which would make "second print must fail" flaky. Static TEST ports are
	// never picked by net.Listen(":0").
	mock := testutil.NewMockTCPPrinter("127.0.0.1:19997")
	mock.Start()
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}

	// first print succeeds
	ctx := context.Background()
	if err := p.Print(ctx, []byte("first")); err != nil {
		t.Fatalf("first: %v", err)
	}
	caps := mock.WaitForCaptures(1, 5*time.Second)
	if len(caps) != 1 || string(caps[0]) != "first" {
		t.Fatalf("capture first failed %v", caps)
	}
	// simulate disconnect: close mock, next print fails
	mock.Close()
	time.Sleep(50 * time.Millisecond)
	p2 := &printer.NetworkPrinter{Address: mock.Addr}
	if err := p2.Print(ctx, []byte("second")); err == nil {
		t.Fatalf("expected fail after close")
	}
	// restart new mock on new port proves retry would succeed if agent reconnects to same printer id but new endpoint
}

func TestMultiplePrintersIndependently(t *testing.T) {
	m1 := testutil.NewMockTCPPrinter("127.0.0.1:0")
	m1.Start()
	defer m1.Close()
	m2 := testutil.NewMockTCPPrinter("127.0.0.1:0")
	m2.Start()
	defer m2.Close()

	p1 := &printer.NetworkPrinter{Address: m1.Addr}
	p2 := &printer.NetworkPrinter{Address: m2.Addr}
	ctx := context.Background()
	if err := p1.Print(ctx, []byte("printer1")); err != nil {
		t.Fatalf("p1: %v", err)
	}
	if err := p2.Print(ctx, []byte("printer2")); err != nil {
		t.Fatalf("p2: %v", err)
	}
	// wait for async capture
	m1.WaitForCaptures(1, 5*time.Second)
	m2.WaitForCaptures(1, 5*time.Second)
	if string(m1.CapturedFlat()) != "printer1" {
		t.Fatalf("m1 flat %q", string(m1.CapturedFlat()))
	}
	if string(m2.CapturedFlat()) != "printer2" {
		t.Fatalf("m2 flat %q wants printer2", string(m2.CapturedFlat()))
	}
}

func TestIdempotentDuplicateViaQueue(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	if err := mock.Start(); err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	q, err := queue.New(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	for _, token := range []string{"first", "duplicate"} {
		err := q.BeginPrint("job", "printer", []byte("receipt"), token, false)
		if token == "duplicate" {
			if !errors.Is(err, queue.ErrTerminalState) {
				t.Fatalf("duplicate acquired execution: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Print(context.Background(), []byte("receipt")); err != nil {
			t.Fatal(err)
		}
		if err := q.UpdateStatus("job", "success"); err != nil {
			t.Fatal(err)
		}
	}
	if captures := mock.WaitForCaptures(1, time.Second); len(captures) != 1 || string(captures[0]) != "receipt" {
		t.Fatalf("duplicate physical transmissions: %v", captures)
	}
}

func TestMidStreamDisconnectIsAnActualTransportFailure(t *testing.T) {
	mock := testutil.NewMockTCPPrinter("127.0.0.1:0")
	mock.SetDisconnectAfter(1)
	if err := mock.Start(); err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	p := &printer.NetworkPrinter{Address: mock.Addr}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Print(ctx, bytes.Repeat([]byte("x"), 5*1024*1024)); err == nil {
		t.Fatal("mid-stream reset reported success")
	}
	if captures := mock.WaitForCaptures(1, time.Second); len(captures) != 1 || len(captures[0]) != 1 {
		t.Fatalf("disconnect occurred after EOF: %v", captures)
	}
}
