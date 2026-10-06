package printer

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIPPAuthenticatedStatusAndAdmission(t *testing.T) {
	for _, tc := range []struct {
		accepting bool
		state     int32
		want      string
	}{
		{true, 3, "online"}, {true, 4, "busy"}, {false, 3, "error"}, {false, 4, "error"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, pass, ok := r.BasicAuth()
			if !ok || user != "user" || pass != "private" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			var buf bytes.Buffer
			buf.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 4})
			writeIPPIntAttr(&buf, 0x23, "printer-state", tc.state)
			writeIPPBoolAttr(&buf, "printer-is-accepting-jobs", tc.accepting)
			buf.WriteByte(3)
			w.Write(buf.Bytes())
		}))
		p, err := NewIPPPrinter(strings.Replace(server.URL, "http://", "http://user:private@", 1), "secure")
		if err != nil {
			t.Fatal(err)
		}
		if got := p.Status(); got != tc.want {
			t.Errorf("accepting=%v state=%d: %s, want %s", tc.accepting, tc.state, got, tc.want)
		}
		server.Close()
	}
}

func TestIPPIncompleteSuccessRemainsUnknown(t *testing.T) {
	for _, response := range [][]byte{
		{2, 0, 0, 0, 0, 0, 0, 1}, // complete header, no attribute terminator
		{2, 0, 0, 0, 0, 0, 0, 1, 4, 0x41, 0, 1, 'a', 0, 5, 'x'},
		{2, 0, 0, 0, 0, 0, 0, 2, 3},  // wrong request ID
		{99, 0, 0, 0, 0, 0, 0, 1, 3}, // invalid protocol version
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(response) }))
		p, _ := NewIPPPrinter(server.URL, "truncated")
		err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validTestPDFBytes()})
		if err == nil || !OutcomeUnknown(err) {
			t.Errorf("malformed success must remain unknown: %v", err)
		}
		server.Close()
	}
}

type deadlineFailureConn struct {
	net.Conn
	writes    int
	failFirst bool
}

func (c *deadlineFailureConn) SetWriteDeadline(time.Time) error {
	if c.failFirst || c.writes > 0 {
		return errors.New("deadline failed")
	}
	return nil
}
func (c *deadlineFailureConn) Write(data []byte) (int, error) { c.writes++; return len(data), nil }

func TestDeadlineFailureUsesPhysicalEvidence(t *testing.T) {
	for _, failFirst := range []bool{true, false} {
		conn := &deadlineFailureConn{failFirst: failFirst}
		written, err := writePrintPayload(context.Background(), conn, make([]byte, networkWriteChunkSize+1), "mock")
		if err == nil {
			t.Fatal("expected deadline failure")
		}
		if OutcomeUnknown(err) != (written > 0) {
			t.Fatalf("written=%d: incorrect outcome: %v", written, err)
		}
	}
}
