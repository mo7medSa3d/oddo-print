package printer

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
)

type countingIPPTransport struct{ requests atomic.Int32 }

func (c *countingIPPTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.requests.Add(1)
	return nil, errors.New("unexpected IPP submission")
}

func TestIPPAdmissionRefusalSendsNoDocument(t *testing.T) {
	transport := &countingIPPTransport{}
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = previous })
	p, err := NewIPPPrinter("http://printer.test/ipp/print", "test")
	if err != nil {
		t.Fatal(err)
	}
	refused := errors.New("printer disabled after preparation")
	ctx := WithDispatchAdmission(context.Background(), func(context.Context) error { return refused })
	err = p.Print(ctx, []byte("%PDF-1.4\n%%EOF"))
	if !errors.Is(err, refused) || OutcomeUnknown(err) || transport.requests.Load() != 0 {
		t.Fatalf("refused IPP reached submission: err=%v requests=%d", err, transport.requests.Load())
	}
}

func TestNetworkAdmissionRefusalSendsNoPrintBytes(t *testing.T) {
	conn, peer := net.Pipe() // actual print writer after the dial/preflight phase
	defer conn.Close()
	defer peer.Close()
	data := make(chan []byte, 1)
	go func() {
		bytes, _ := io.ReadAll(peer)
		data <- bytes
	}()
	refused := errors.New("claim expired after preflight")
	ctx := WithDispatchAdmission(context.Background(), func(context.Context) error { return refused })
	written, err := writePrintPayload(ctx, conn, []byte("receipt"), "test")
	_ = conn.Close()
	if !errors.Is(err, refused) || OutcomeUnknown(err) || written != 0 {
		t.Fatalf("admission failure misclassified: %v", err)
	}
	if received := <-data; len(received) != 0 {
		t.Fatalf("refused network job sent %d print bytes", len(received))
	}
}
