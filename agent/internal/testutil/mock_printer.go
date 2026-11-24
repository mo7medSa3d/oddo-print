// Package testutil provides TEST-ONLY mock infrastructure. Never import from production code.
package testutil

import (
	"io"
	"log"
	"net"
	"sort"
	"sync"
	"time"
)

// MockTCPPrinter listens on 127.0.0.1:9100 (or ephemeral) and captures bytes.
// Supports failure modes: refuse, delay, disconnect mid-write.
// Test-only; production code must never import testutil.
type MockTCPPrinter struct {
	Addr string
	ln   net.Listener
	mu   sync.Mutex
	// captured payloads, one per connection, tagged with accept-order sequence
	// number so concurrent per-connection handler goroutines can't reorder
	// results relative to the order connections were accepted in.
	captured []captureEntry
	nextSeq  int
	// behavior knobs
	delay            time.Duration
	disconnectAfter  int // if >0, close after reading N bytes
	acceptFail       bool
	partialReadLimit int // if >0, read only N bytes then stall
	closed           bool
	closeCh          chan struct{}
	connections      map[net.Conn]struct{}
	handlers         sync.WaitGroup
}

type captureEntry struct {
	seq  int
	data []byte
}

func NewMockTCPPrinter(addr string) *MockTCPPrinter {
	if addr == "" {
		addr = "127.0.0.1:9100"
	}
	return &MockTCPPrinter{Addr: addr, closeCh: make(chan struct{}), connections: make(map[net.Conn]struct{})}
}

func (m *MockTCPPrinter) Start() error {
	ln, err := net.Listen("tcp", m.Addr)
	if err != nil {
		return err
	}
	m.ln = ln
	m.Addr = ln.Addr().String()
	go m.acceptLoop()
	return nil
}

func (m *MockTCPPrinter) acceptLoop() {
	for {
		conn, err := m.ln.Accept()
		if err != nil {
			return
		}
		m.mu.Lock()
		if m.closed || m.acceptFail {
			m.mu.Unlock()
			conn.Close()
			continue
		}
		seq := m.nextSeq
		m.nextSeq++
		m.connections[conn] = struct{}{}
		m.handlers.Add(1)
		m.mu.Unlock()
		go m.handle(conn, seq)
	}
}

func (m *MockTCPPrinter) handle(conn net.Conn, seq int) {
	defer m.handlers.Done()
	defer func() { _ = conn.Close(); m.mu.Lock(); delete(m.connections, conn); m.mu.Unlock() }()
	m.mu.Lock()
	delay, disconnect, partial := m.delay, m.disconnectAfter, m.partialReadLimit
	m.mu.Unlock()
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-m.closeCh:
			return
		}
	}
	var reader io.Reader = conn
	limit := disconnect
	if partial > 0 && (limit <= 0 || partial < limit) {
		limit = partial
	}
	if limit > 0 {
		// Bound the real socket read BEFORE consuming the rest of the stream.
		// A tiny receive window forces large production writes to stall.
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
		reader = io.LimitReader(conn, int64(limit))
	}
	data, readErr := io.ReadAll(reader)
	if readErr != nil {
		log.Printf("mock printer: read from %s failed after %d bytes: %v", conn.RemoteAddr(), len(data), readErr)
	}
	m.mu.Lock()
	m.captured = append(m.captured, captureEntry{seq: seq, data: data})
	m.mu.Unlock()
	if disconnect > 0 && len(data) >= disconnect {
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0)
		}
		return
	}
	if partial > 0 && len(data) >= partial {
		// Keep the connection open without reading until explicit shutdown.
		<-m.closeCh
	}

}

// sortedCaptured returns a copy of m.captured ordered by accept sequence
// (i.e. the order connections arrived in), not by handler-goroutine
// completion order. Caller must hold m.mu.
func (m *MockTCPPrinter) sortedCaptured() []captureEntry {
	sorted := make([]captureEntry, len(m.captured))
	copy(sorted, m.captured)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].seq < sorted[j].seq })
	return sorted
}

func (m *MockTCPPrinter) Captured() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	sorted := m.sortedCaptured()
	out := make([][]byte, len(sorted))
	for i, c := range sorted {
		cp := make([]byte, len(c.data))
		copy(cp, c.data)
		out[i] = cp
	}
	return out
}

func (m *MockTCPPrinter) CapturedFlat() []byte {
	var flat []byte
	for _, c := range m.Captured() {
		flat = append(flat, c...)
	}
	return flat
}

func (m *MockTCPPrinter) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.captured)
}

func (m *MockTCPPrinter) Reset() {
	m.mu.Lock()
	m.captured = nil
	m.nextSeq = 0
	m.mu.Unlock()
}

func (m *MockTCPPrinter) SetDelay(d time.Duration) { m.mu.Lock(); m.delay = d; m.mu.Unlock() }
func (m *MockTCPPrinter) SetDisconnectAfter(n int) { m.mu.Lock(); m.disconnectAfter = n; m.mu.Unlock() }
func (m *MockTCPPrinter) SetPartialReadLimit(n int) {
	m.mu.Lock()
	m.partialReadLimit = n
	m.mu.Unlock()
}

func (m *MockTCPPrinter) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	close(m.closeCh)
	connections := make([]net.Conn, 0, len(m.connections))
	for conn := range m.connections {
		connections = append(connections, conn)
	}
	listener := m.ln
	m.mu.Unlock()
	var err error
	if listener != nil {
		err = listener.Close()
	}
	for _, conn := range connections {
		_ = conn.Close()
	}
	m.handlers.Wait()
	return err
}

// WaitForCaptures blocks until at least want captures or timeout.
func (m *MockTCPPrinter) WaitForCaptures(want int, timeout time.Duration) [][]byte {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if m.Count() >= want {
			return m.Captured()
		}
		time.Sleep(20 * time.Millisecond)
	}
	return m.Captured()
}
