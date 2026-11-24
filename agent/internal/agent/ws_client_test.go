package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDeriveOdooWSURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://odoo.example.com", "wss://odoo.example.com/api/agent/ws"},
		{"http://127.0.0.1:8069/", "ws://127.0.0.1:8069/api/agent/ws"},
		{"wss://print.example.com:8443/old", "wss://print.example.com:8443/api/agent/ws"},
	}
	for _, tc := range cases {
		got, err := deriveOdooWSURL(tc.in)
		if err != nil {
			t.Fatalf("deriveOdooWSURL(%q) error: %v", tc.in, err)
		}
		if got.String() != tc.want {
			t.Fatalf("deriveOdooWSURL(%q) = %q, want %q", tc.in, got.String(), tc.want)
		}
	}
}

func writeUnmaskedServerFrame(w io.Writer, fin bool, op byte, payload []byte) error {
	b0 := op & 0x0F
	if fin {
		b0 |= 0x80
	}
	plen := len(payload)
	var hdr []byte
	switch {
	case plen < 126:
		hdr = []byte{b0, byte(plen)}
	case plen <= 65535:
		hdr = []byte{b0, 126, byte(plen >> 8), byte(plen)}
	default:
		hdr = make([]byte, 10)
		hdr[0] = b0
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(plen))
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if plen > 0 {
		_, err := w.Write(payload)
		return err
	}
	return nil
}

func readMaskedClientFrame(r io.Reader) (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	op := hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	if !masked {
		return 0, nil, errors.New("expected masked client frame")
	}
	plen := uint64(hdr[1] & 0x7F)
	switch plen {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		plen = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		plen = binary.BigEndian.Uint64(ext[:])
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return 0, nil, err
	}
	data := make([]byte, int(plen))
	if plen > 0 {
		if _, err := io.ReadFull(r, data); err != nil {
			return 0, nil, err
		}
		for i := range data {
			data[i] ^= mask[i%4]
		}
	}
	return op, data, nil
}

func TestDialOdooWSHandshakeAndFraming(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()

	serverErrCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverErrCh <- err
			return
		}
		defer conn.Close()

		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			serverErrCh <- err
			return
		}
		if req.URL.Path != "/api/agent/ws" {
			serverErrCh <- errors.New("unexpected ws path: " + req.URL.Path)
			return
		}
		if req.Header.Get("Authorization") != "Bearer agent-1:secret-1" || req.Header.Get("X-Agent-Id") != "agent-1" {
			serverErrCh <- errors.New("missing auth or agent id headers")
			return
		}
		accept := computeWSAccept(req.Header.Get("Sec-WebSocket-Key"))
		resp := "HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
		if _, err := io.WriteString(conn, resp); err != nil {
			serverErrCh <- err
			return
		}

		// 1. Send a ping and verify client auto-replies with masked pong.
		if err := writeUnmaskedServerFrame(conn, true, wsOpPing, []byte("hb")); err != nil {
			serverErrCh <- err
			return
		}
		op, pongData, err := readMaskedClientFrame(br)
		if err != nil || op != wsOpPong || string(pongData) != "hb" {
			serverErrCh <- errors.New("expected masked pong with payload 'hb'")
			return
		}

		// 2. Send a fragmented text message with an interleaved control ping (RFC 6455 §5.4).
		if err := writeUnmaskedServerFrame(conn, false, wsOpText, []byte(`{"type":"job_`)); err != nil {
			serverErrCh <- err
			return
		}
		if err := writeUnmaskedServerFrame(conn, true, wsOpPing, []byte("mid")); err != nil {
			serverErrCh <- err
			return
		}
		opMid, pongMid, err := readMaskedClientFrame(br)
		if err != nil || opMid != wsOpPong || string(pongMid) != "mid" {
			serverErrCh <- errors.New("expected masked pong for interleaved ping")
			return
		}
		if err := writeUnmaskedServerFrame(conn, true, wsOpContinuation, []byte(`available"}`)); err != nil {
			serverErrCh <- err
			return
		}

		// 3. Send a 16-bit extended length payload (>125 bytes).
		bigPayload := bytes.Repeat([]byte("a"), 300)
		if err := writeUnmaskedServerFrame(conn, true, wsOpText, bigPayload); err != nil {
			serverErrCh <- err
			return
		}

		// 4. Send close frame and expect close echo.
		if err := writeUnmaskedServerFrame(conn, true, wsOpClose, []byte{0x03, 0xe8}); err != nil {
			serverErrCh <- err
			return
		}
		closeOp, _, err := readMaskedClientFrame(br)
		if err != nil || closeOp != wsOpClose {
			serverErrCh <- errors.New("expected close echo")
			return
		}
		serverErrCh <- nil
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, err := dialOdooWS(ctx, "http://"+ln.Addr().String(), "agent-1", "agent-1:secret-1")
	if err != nil {
		t.Fatalf("dialOdooWS failed: %v", err)
	}
	defer ws.Close()

	op, msg, err := ws.ReadMessage()
	if err != nil || op != wsOpText || string(msg) != `{"type":"job_available"}` {
		t.Fatalf("unexpected fragmented message: op=%d msg=%q err=%v", op, string(msg), err)
	}

	op, bigMsg, err := ws.ReadMessage()
	if err != nil || op != wsOpText || len(bigMsg) != 300 || !strings.HasPrefix(string(bigMsg), "aaa") {
		t.Fatalf("unexpected 16-bit frame: op=%d len=%d err=%v", op, len(bigMsg), err)
	}

	_, _, err = ws.ReadMessage()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("expected io.EOF on server close, got %v", err)
	}

	if srvErr := <-serverErrCh; srvErr != nil {
		t.Fatalf("mock ws server error: %v", srvErr)
	}
}

func TestWSReadMessageRejectsNonZeroRSV(t *testing.T) {
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()

	ws := &wsConn{conn: c1, br: bufio.NewReader(c1)}
	go func() {
		// RSV1=1, FIN=1, opcode=text, unmasked, len=0
		_, _ = c2.Write([]byte{0xC1, 0x00})
		// Drain client's 1002 close frame so WriteClose does not block on net.Pipe.
		_, _ = io.Copy(io.Discard, c2)
	}()

	_, _, err := ws.ReadMessage()
	if !errors.Is(err, errWSProtocol) {
		t.Fatalf("expected errWSProtocol for non-zero RSV, got %v", err)
	}
}
