package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	wsMagicGUID       = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	wsMaxFramePayload = 16 << 20 // 16 MiB cap
	wsMaxFragments    = 1024
	wsPingInterval    = 25 * time.Second
	wsReadTimeout     = 75 * time.Second
	wsWriteTimeout    = 10 * time.Second
	wsHandshakeBudget = 10 * time.Second

	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xA
)

var (
	errWSHandshakeFailed = errors.New("websocket handshake failed")
	errWSUnauthorized    = errors.New("websocket unauthorized")
	errWSFrameTooLarge   = errors.New("websocket frame exceeds 16 MiB limit")
	errWSProtocol        = errors.New("websocket protocol error")
)

// wsConn is a minimal, zero-dependency RFC 6455 WebSocket client connection.
type wsConn struct {
	conn      net.Conn
	br        *bufio.Reader
	writeMu   sync.Mutex
	closeOnce sync.Once
}

// deriveOdooWSURL converts an http(s):// or ws(s):// Odoo origin URL to ws(s)://<host>/api/agent/ws.
func deriveOdooWSURL(odooURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(odooURL))
	if err != nil {
		return nil, fmt.Errorf("parse odoo url: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return nil, fmt.Errorf("unsupported scheme %q for websocket", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, errors.New("empty host in odoo url")
	}
	u.Path = "/api/agent/ws"
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

func computeWSAccept(secKey string) string {
	sum := sha1.Sum([]byte(secKey + wsMagicGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func dialOdooWS(ctx context.Context, odooURL, agentID, token string) (*wsConn, error) {
	u, err := deriveOdooWSURL(odooURL)
	if err != nil {
		return nil, err
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(host, port)

	dialer := &net.Dialer{
		Timeout:   wsHandshakeBudget,
		KeepAlive: 20 * time.Second,
	}
	rawConn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("ws dial %s: %w", addr, err)
	}

	conn := rawConn
	if u.Scheme == "wss" {
		tlsConn := tls.Client(rawConn, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
		tlsCtx, tlsCancel := context.WithTimeout(ctx, wsHandshakeBudget)
		err = tlsConn.HandshakeContext(tlsCtx)
		tlsCancel()
		if err != nil {
			_ = rawConn.Close()
			return nil, fmt.Errorf("ws tls handshake: %w", err)
		}
		conn = tlsConn
	}

	var nonce [16]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ws nonce: %w", err)
	}
	secKey := base64.StdEncoding.EncodeToString(nonce[:])

	if strings.ContainsAny(token, "\r\n") || strings.ContainsAny(agentID, "\r\n") {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: invalid header characters", errWSHandshakeFailed)
	}

	deadline := time.Now().Add(wsHandshakeBudget)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		_ = conn.Close()
		return nil, err
	}

	// Unblock handshake I/O immediately when ctx cancels without a deadline.
	handshakeDone := false
	stopCancel := context.AfterFunc(ctx, func() {
		_ = conn.SetDeadline(time.Now())
	})
	defer func() {
		if !handshakeDone {
			stopCancel()
		}
	}()

	var reqBuf strings.Builder
	reqBuf.WriteString("GET " + u.RequestURI() + " HTTP/1.1\r\n")
	reqBuf.WriteString("Host: " + u.Host + "\r\n")
	reqBuf.WriteString("Upgrade: websocket\r\n")
	reqBuf.WriteString("Connection: Upgrade\r\n")
	reqBuf.WriteString("Sec-WebSocket-Key: " + secKey + "\r\n")
	reqBuf.WriteString("Sec-WebSocket-Version: 13\r\n")
	if token != "" {
		reqBuf.WriteString("Authorization: Bearer " + token + "\r\n")
	}
	if agentID != "" {
		reqBuf.WriteString("X-Agent-Id: " + agentID + "\r\n")
	}
	reqBuf.WriteString("\r\n")

	if _, err := io.WriteString(conn, reqBuf.String()); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ws write upgrade: %w", err)
	}

	br := bufio.NewReaderSize(conn, 8192)
	dummyReq, _ := http.NewRequest(http.MethodGet, u.String(), nil)
	resp, err := http.ReadResponse(br, dummyReq)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ws read upgrade response: %w", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		if resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("%w: %w: status %d", errWSHandshakeFailed, errWSUnauthorized, resp.StatusCode)
		}
		return nil, fmt.Errorf("%w: status %d", errWSHandshakeFailed, resp.StatusCode)
	}
	if !strings.EqualFold(strings.TrimSpace(resp.Header.Get("Upgrade")), "websocket") {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: missing Upgrade: websocket header", errWSHandshakeFailed)
	}
	expectedAccept := computeWSAccept(secKey)
	if strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept")) != expectedAccept {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: invalid Sec-WebSocket-Accept", errWSHandshakeFailed)
	}

	if !stopCancel() {
		_ = conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, context.Canceled
	}
	handshakeDone = true
	// Clear handshake deadline; frame reads/writes manage their own deadlines.
	_ = conn.SetDeadline(time.Time{})
	return &wsConn{conn: conn, br: br}, nil
}

func (c *wsConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.conn.Close()
	})
	return err
}

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)); err != nil {
		return err
	}

	var maskKey [4]byte
	if _, err := io.ReadFull(rand.Reader, maskKey[:]); err != nil {
		return err
	}

	plen := len(payload)
	header := make([]byte, 0, 14)
	header = append(header, 0x80|(opcode&0x0F)) // FIN=1

	switch {
	case plen < 126:
		header = append(header, 0x80|byte(plen))
	case plen <= 65535:
		header = append(header, 0x80|126, byte(plen>>8), byte(plen))
	default:
		var lenBuf [8]byte
		binary.BigEndian.PutUint64(lenBuf[:], uint64(plen))
		header = append(header, 0x80|127)
		header = append(header, lenBuf[:]...)
	}
	header = append(header, maskKey[:]...)

	frame := make([]byte, len(header)+plen)
	copy(frame, header)
	for i := 0; i < plen; i++ {
		frame[len(header)+i] = payload[i] ^ maskKey[i%4]
	}

	_, err := c.conn.Write(frame)
	return err
}

func (c *wsConn) WritePing(data []byte) error {
	if len(data) > 125 {
		data = data[:125]
	}
	return c.writeFrame(wsOpPing, data)
}

func (c *wsConn) WritePong(data []byte) error {
	if len(data) > 125 {
		data = data[:125]
	}
	return c.writeFrame(wsOpPong, data)
}

func (c *wsConn) WriteClose(code uint16, reason string) error {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	buf := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(buf[:2], code)
	copy(buf[2:], reason)
	return c.writeFrame(wsOpClose, buf)
}

// ReadMessage reads the next complete data message (text or binary), handling
// fragmented frames, automatic ping->pong replies, and close handshakes.
func (c *wsConn) ReadMessage() (byte, []byte, error) {
	var msgOp byte
	var msgBuf []byte
	inFrag := false
	fragCount := 0

	for {
		if err := c.conn.SetReadDeadline(time.Now().Add(wsReadTimeout)); err != nil {
			return 0, nil, err
		}
		var hdr [2]byte
		if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
			return 0, nil, err
		}

		fin := (hdr[0] & 0x80) != 0
		if (hdr[0] & 0x70) != 0 {
			_ = c.WriteClose(1002, "non-zero rsv bits")
			return 0, nil, fmt.Errorf("%w: non-zero rsv bits", errWSProtocol)
		}
		op := hdr[0] & 0x0F
		masked := (hdr[1] & 0x80) != 0
		plen := uint64(hdr[1] & 0x7F)

		if masked {
			// RFC 6455 §5.1: server-to-client frames must not be masked.
			_ = c.WriteClose(1002, "masked server frame")
			return 0, nil, fmt.Errorf("%w: masked server frame", errWSProtocol)
		}

		switch plen {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			plen = uint64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return 0, nil, err
			}
			if (ext[0] & 0x80) != 0 {
				_ = c.WriteClose(1002, "invalid 64-bit length")
				return 0, nil, fmt.Errorf("%w: invalid 64-bit length", errWSProtocol)
			}
			plen = binary.BigEndian.Uint64(ext[:])
		}

		if plen > wsMaxFramePayload {
			_ = c.WriteClose(1009, "frame too large")
			return 0, nil, errWSFrameTooLarge
		}

		payload := make([]byte, int(plen))
		if plen > 0 {
			if _, err := io.ReadFull(c.br, payload); err != nil {
				return 0, nil, err
			}
		}

		// Control frames (0x8..0xF) may be interleaved with fragmented messages.
		if op >= 0x8 {
			if !fin || plen > 125 {
				_ = c.WriteClose(1002, "invalid control frame")
				return 0, nil, fmt.Errorf("%w: invalid control frame", errWSProtocol)
			}
			switch op {
			case wsOpPing:
				if err := c.WritePong(payload); err != nil {
					return 0, nil, err
				}
			case wsOpPong:
				// Keep-alive confirmed; continue reading.
			case wsOpClose:
				_ = c.WriteClose(1000, "")
				return wsOpClose, payload, io.EOF
			default:
				_ = c.WriteClose(1002, "unknown control opcode")
				return 0, nil, fmt.Errorf("%w: unknown control opcode %d", errWSProtocol, op)
			}
			continue
		}

		if !inFrag {
			if op == wsOpContinuation {
				_ = c.WriteClose(1002, "unexpected continuation")
				return 0, nil, fmt.Errorf("%w: unexpected continuation frame", errWSProtocol)
			}
			if op != wsOpText && op != wsOpBinary {
				_ = c.WriteClose(1002, "unsupported opcode")
				return 0, nil, fmt.Errorf("%w: unsupported opcode %d", errWSProtocol, op)
			}
			msgOp = op
			if fin {
				return msgOp, payload, nil
			}
			msgBuf = append(msgBuf[:0], payload...)
			inFrag = true
			fragCount = 1
			continue
		}

		if op != wsOpContinuation {
			_ = c.WriteClose(1002, "expected continuation")
			return 0, nil, fmt.Errorf("%w: expected continuation frame", errWSProtocol)
		}
		fragCount++
		if fragCount > wsMaxFragments {
			_ = c.WriteClose(1009, "too many fragments")
			return 0, nil, fmt.Errorf("%w: fragmented message exceeds %d frames", errWSProtocol, wsMaxFragments)
		}
		if uint64(len(msgBuf))+plen > wsMaxFramePayload {
			_ = c.WriteClose(1009, "message too large")
			return 0, nil, errWSFrameTooLarge
		}
		msgBuf = append(msgBuf, payload...)
		if fin {
			return msgOp, msgBuf, nil
		}
	}
}
