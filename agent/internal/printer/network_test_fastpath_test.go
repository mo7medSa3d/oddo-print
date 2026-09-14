package printer

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestNetworkPrinterTestPathSkipsStatusPreflightAndReturnsPromptly(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	received := make(chan []byte, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 1024)
		n, _ := conn.Read(buf)
		received <- append([]byte(nil), buf[:n]...)
	}()

	p := &NetworkPrinter{Address: ln.Addr().String(), Protocol: "escpos"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	if err := p.Test(ctx); err != nil {
		t.Fatalf("test print failed: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("healthy test print took %s; status preflight/discovery delay leaked into print path", elapsed)
	}
	select {
	case got := <-received:
		want := []byte("\x1b\x40Hello from Odoo Agent!\n\n\x1d\x56\x01")
		if string(got) != string(want) {
			t.Fatalf("received %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("printer did not receive the test bytes")
	}
}

func TestNetworkPrinterTestPathFailsPromptlyOnRefusedConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := ln.Addr().String()
	_ = ln.Close()

	p := &NetworkPrinter{Address: address, Protocol: "escpos"}
	start := time.Now()
	err = p.Test(context.Background())
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("refused printer connection unexpectedly reported success")
	}
	if elapsed >= time.Second {
		t.Fatalf("refused printer test took %s; failure path should return promptly", elapsed)
	}
}
