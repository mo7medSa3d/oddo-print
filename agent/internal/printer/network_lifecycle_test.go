package printer

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

type incompleteHealthWriter struct {
	reader                *bytes.Reader
	failAt, writes, count int
	err                   error
}

func (c *incompleteHealthWriter) Write(data []byte) (int, error) {
	c.writes++
	if c.writes == c.failAt {
		return c.count, c.err
	}
	return len(data), nil
}

func (c *incompleteHealthWriter) Read(data []byte) (int, error) {
	return c.reader.Read(data)
}

func TestESCPOSIncompleteInquiryWriteNeverEstablishesStatus(t *testing.T) {
	for i, stage := range []string{"printer", "offline", "paper"} {
		for _, failure := range []struct {
			name  string
			count int
			err   error
		}{
			{"zero_progress", 0, nil},
			{"partial_command", 2, nil},
			{"write_timeout", 2, &net.OpError{Op: "write", Net: "tcp", Err: os.ErrDeadlineExceeded}},
		} {
			t.Run(stage+"/"+failure.name, func(t *testing.T) {
				channel := &incompleteHealthWriter{reader: bytes.NewReader([]byte{0x12, 0x12, 0x12}), failAt: i + 1, count: failure.count, err: failure.err}
				status, err := QueryHealthStatus(channel)
				if status != nil || err == nil || errors.Is(err, ErrPrinterStatusUnsupported) {
					t.Fatalf("failed command write became optional unreadable status: status=%v error=%v", status, err)
				}
				want := failure.err
				if want == nil {
					want = io.ErrShortWrite
				}
				if !errors.Is(err, want) || channel.writes != i+1 || channel.reader.Len() != 3-i {
					t.Fatalf("inquiry continued after an incomplete command: writes=%d unread=%d error=%v", channel.writes, channel.reader.Len(), err)
				}
			})
		}
	}
}

type networkEOFEvidenceConn struct {
	net.Conn
	payload       []byte
	closeWriteErr error
	closeWrites   int
}

func (c *networkEOFEvidenceConn) Write(data []byte) (int, error) {
	c.payload = append(c.payload, data...)
	return len(data), nil
}
func (c *networkEOFEvidenceConn) SetWriteDeadline(time.Time) error { return nil }
func (c *networkEOFEvidenceConn) Close() error                     { return nil }
func (c *networkEOFEvidenceConn) CloseWrite() error {
	c.closeWrites++
	return c.closeWriteErr
}

func TestNetworkFailedEOFHandoffIsUnknownWithoutResending(t *testing.T) {
	for _, closeErr := range []error{nil, io.ErrUnexpectedEOF, os.ErrDeadlineExceeded} {
		conn := &networkEOFEvidenceConn{closeWriteErr: closeErr}
		admissions := 0
		ctx := WithDispatchAdmission(context.Background(), func(context.Context) error { admissions++; return nil })
		payload := []byte("receipt\n")
		written, err := writePrintPayload(ctx, conn, payload, "test")
		if written != len(payload) || !bytes.Equal(conn.payload, payload) || conn.closeWrites != 1 || admissions != 1 {
			t.Fatalf("submission retried or lost admission/EOF: written=%d payload=%q halfcloses=%d admissions=%d", written, conn.payload, conn.closeWrites, admissions)
		}
		if closeErr == nil && err != nil {
			t.Fatalf("successful EOF handoff failed: %v", err)
		}
		if closeErr != nil && !OutcomeUnknown(err) {
			t.Fatalf("failed EOF after payload became safely retryable or successful: %v", err)
		}
	}
}

func TestNetworkPreflightCancellationStopsBeforeDocumentBytes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		print func(context.Context, string) error
	}{
		{"print", func(ctx context.Context, address string) error {
			return (&NetworkPrinter{Address: address, Protocol: "escpos"}).Print(ctx, []byte("receipt"))
		}},
		{"health_only", PreFlightHealthCheck},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			queried := make(chan error, 1)
			received := make(chan []byte, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					queried <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
				var command [3]byte
				_, err = io.ReadFull(conn, command[:])
				if err == nil && !bytes.Equal(command[:], cmdInquirePrinterStatus) {
					err = errors.New("unexpected status command")
				}
				queried <- err
				data, _ := io.ReadAll(conn)
				received <- data
			}()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- tc.print(ctx, listener.Addr().String()) }()
			select {
			case err := <-queried:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("status inquiry did not reach the connection")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) || OutcomeUnknown(err) {
					t.Fatalf("pre-document cancellation misclassified: %v", err)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("preflight ignored cancellation and waited for its fixed deadline")
			}
			select {
			case data := <-received:
				if len(data) != 0 {
					t.Fatalf("document/peripheral bytes followed a canceled inquiry: %x", data)
				}
			case <-time.After(time.Second):
				t.Fatal("canceled connection did not close")
			}
		})
	}
}
