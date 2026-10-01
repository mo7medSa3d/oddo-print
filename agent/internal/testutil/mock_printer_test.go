package testutil

import (
	"bytes"
	"log"
	"net"
	"strings"
	"testing"
	"time"
)

// TestMockPrinterReportsReadFailure pins the change made in this pass:
// MockTCPPrinter.handle used to discard the io.ReadAll error entirely, so a
// connection reset mid-capture was recorded as a legitimately short payload and
// surfaced only as a confusing assertion mismatch. The bytes captured are still
// recorded unchanged (partial-capture tests depend on that); only the error is
// now logged.
//
// The client forces a TCP RST (SetLinger(0) then Close) so the server-side read
// genuinely fails rather than returning io.EOF.
func TestMockPrinterReportsReadFailure(t *testing.T) {
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	m := NewMockTCPPrinter("127.0.0.1:0")
	if err := m.Start(); err != nil {
		t.Fatalf("mock start: %v", err)
	}
	defer m.Close()

	conn, err := net.Dial("tcp", m.Addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	tcp := conn.(*net.TCPConn)
	if _, err := tcp.Write([]byte("partial-payload")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = tcp.SetLinger(0) // RST on close instead of FIN
	if err := tcp.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// The handler always records the capture, error or not.
	if caps := m.WaitForCaptures(1, 3*time.Second); len(caps) != 1 {
		t.Fatalf("expected exactly one capture, got %d", len(caps))
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), "mock printer: read from") {
			if !strings.Contains(buf.String(), "failed after") {
				t.Fatalf("read-failure log missing byte count: %q", buf.String())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("expected a read-failure log line, got %q", buf.String())
}
