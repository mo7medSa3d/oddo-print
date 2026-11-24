package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

const maxPrintBytes = 5 * 1024 * 1024

const (
	// dialTimeout: TCP connect for actual print jobs. Reduced from 10s to 5s
	// per 2024-2025 best practice: POS printers should respond in <1s on LAN,
	// 5s is generous and halves user-perceived delay when printer offline.
	// Test pages use 3s (testPrintDialTimeout) for even faster feedback.
	dialTimeout           = 5 * time.Second
	testPrintDialTimeout  = 3 * time.Second
	writeStallTimeout     = 60 * time.Second
	networkWriteChunkSize = 16 * 1024
)

type NetworkPrinter struct {
	Address        string
	Protocol       string
	RasterMaxWidth int
	Geometry       *Geometry

	statusMu         sync.RWMutex
	lastStatusDetail string
	// snmpMissUntil suppresses repeat SNMP status probes for a while
	// after a device did not answer one, so a status cycle on a
	// non-SNMP printer is not taxed the full probe timeout every time.
	// Successful answers are never cached: status stays live.
	snmpMissUntil time.Time
}

// StatusDetail returns the provider detail recorded by the most
// recent Status() call (e.g. snmp_paper_jam), for the heartbeat's
// provider-detail channel.
func (p *NetworkPrinter) StatusDetail() string {
	p.statusMu.RLock()
	defer p.statusMu.RUnlock()
	return p.lastStatusDetail
}

func (p *NetworkPrinter) setStatusDetail(detail string) {
	p.statusMu.Lock()
	p.lastStatusDetail = detail
	p.statusMu.Unlock()
}

func (p *NetworkPrinter) Print(ctx context.Context, data []byte) error {
	return p.printBytes(ctx, data, true, dialTimeout)
}

// printBytes transmits bytes over a single RAW TCP connection. The optional
// ESC/POS preflight is intentionally separate from the test-page path: a RAW
// print stream is write-only by contract, and a diagnostic page must not wait
// for a device status response that is not required to accept print bytes.
func (p *NetworkPrinter) printBytes(ctx context.Context, data []byte, preflight bool, connectTimeout time.Duration) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d bytes exceeds %d limit", len(data), maxPrintBytes)
	}

	// Single connection with keepalive to eliminate connection churn and race conditions.
	dialStart := time.Now()
	d := net.Dialer{
		Timeout:   connectTimeout,
		KeepAlive: 10 * time.Second,
	}
	conn, err := d.DialContext(ctx, "tcp", p.Address)
	if err != nil {
		// Zero bytes sent: provably pre-dispatch failure, safely retryable.
		return fmt.Errorf("%w: dial %s: %w", ErrPrinterOffline, p.Address, err)
	}
	defer conn.Close()
	stopCancellation := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancellation()
	log.Printf("print.trace network_connect address=%s latency_ms=%d", p.Address, time.Since(dialStart).Milliseconds())

	// Active preflight on the OPEN connection before normal ESC/POS document
	// streaming. Test pages deliberately skip this optional status inquiry.
	if preflight && strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		deadline := time.Now().Add(1500 * time.Millisecond)
		if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
			deadline = contextDeadline
		}
		if err := conn.SetDeadline(deadline); err != nil {
			return fmt.Errorf("set printer health deadline: %w", err)
		}
		if _, err := QueryHealthStatus(conn); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, ErrPrinterStatusUnsupported) {
				log.Printf("printer %s: ESC/POS status channel unavailable (%v); proceeding without health proof", p.Address, err)
			} else {
				return fmt.Errorf("pre-flight health check failed: %w", err)
			}
		}
		// Reset read/write deadline
		if err := conn.SetDeadline(time.Time{}); err != nil {
			return fmt.Errorf("reset printer deadline: %w", err)
		}
	}

	writeStart := time.Now()
	written, err := writePrintPayload(ctx, conn, data, p.Address)
	if err != nil {
		return err
	}

	log.Printf("print.trace network_write address=%s bytes=%d latency_ms=%d", p.Address, written, time.Since(writeStart).Milliseconds())

	return nil
}

// SupportsKind exposes the render paths this byte-stream backend can produce.
// The per-protocol device compatibility decision (which payload protocol may
// touch which device protocol) is enforced by PayloadCompatibleForDevice in
// the job pipeline; this coarse gate only reflects transport capability.
func (p *NetworkPrinter) SupportsKind(kind string) bool {
	k := NormalizeKind(kind)
	switch strings.ToLower(strings.TrimSpace(p.Protocol)) {
	case "zpl":
		return k == KindRaw || k == KindZPL || k == KindLabel
	case "tspl":
		return k == KindRaw || k == KindTSPL || k == KindLabel
	case "escpos":
		return k == KindRaw || k == KindESCPOS || (k == KindImage && rasterGeometryReady(p.Geometry))
	case "raw":
		return k == KindRaw
	case "":
		return k == KindRaw || k == KindESCPOS
	default:
		return false
	}
}

func writePrintPayload(ctx context.Context, conn net.Conn, data []byte, address string) (int, error) {
	if err := runDispatchAdmission(ctx); err != nil {
		return 0, fmt.Errorf("network print admission refused: %w", err)
	}
	// Closing the owned print connection interrupts a blocked Write even
	// for contexts cancelled without a deadline.
	stopCancellation := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancellation()
	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			if written > 0 {
				return written, MarkUnknown("print cancelled after %d/%d bytes: %v", written, len(data), ctx.Err())
			}
			return written, fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		chunk := data[written:]
		if len(chunk) > networkWriteChunkSize {
			chunk = chunk[:networkWriteChunkSize]
		}
		deadline := time.Now().Add(writeStallTimeout)
		if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
			deadline = contextDeadline
		}
		if err := conn.SetWriteDeadline(deadline); err != nil {
			if written > 0 {
				return written, MarkUnknown("set printer write deadline after %d/%d bytes: %v", written, len(data), err)
			}
			return written, fmt.Errorf("set printer write deadline: %w", err)
		}
		n, err := conn.Write(chunk)
		if n < 0 || n > len(chunk) {
			// Inconsistent transport counters are not byte-delivery proof.
			// Never index with a negative offset or treat an over-report
			// as a completed receipt. The attempted write is ambiguous.
			return written, MarkUnknown("network write to %s returned invalid confirmed-byte count %d for %d-byte chunk after %d/%d bytes", address, n, len(chunk), written, len(data))
		}
		written += n
		if err != nil {
			// Once Write was attempted, a zero byte *return count* does not
			// prove the device received nothing. The driver could have
			// submitted bytes before reporting failure. Keep the original
			// attempt ambiguous regardless of the confirmed count.
			return written, MarkUnknown("network write to %s failed after %d/%d confirmed bytes: %v", address, written, len(data), err)
		}
		if n == 0 {
			// A successful Write with no reported progress violates net.Conn
			// but can still have handed data to a printer. Failing as plain
			// not_printed could automatically duplicate a receipt.
			return written, MarkUnknown("network Write to %s reported zero progress after %d/%d confirmed bytes", address, written, len(data))
		}
	}
	// Complete the same owned TCP stream; buffered writes alone cannot make a
	// failed EOF handoff a successful submission or justify a safe retry.
	if writer, ok := conn.(interface{ CloseWrite() error }); ok {
		if err := writer.CloseWrite(); err != nil {
			return written, MarkUnknown("TCP half-close to %s failed after %d/%d bytes: %v", address, written, len(data), err)
		}
	}
	return written, nil
}

func (p *NetworkPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	if !p.SupportsKind(kind) {
		return CapabilityMismatchf("raw TCP printer %s (%s) does not support %s payloads", p.Address, p.Protocol, kind)
	}
	switch kind {
	case KindRaw, KindESCPOS, KindZPL, KindTSPL, KindLabel:
		return p.Print(ctx, doc.Data)
	case KindImage:
		data, err := prepareESCPOSImageForDispatch(ctx, p.Protocol, p.Geometry, doc)
		if err != nil {
			return fmt.Errorf("render image for raw TCP printer: %w", err)
		}
		return p.Print(ctx, data)
	default:
		return CapabilityMismatchf("raw TCP printer %s cannot render %s payloads", p.Address, kind)
	}
}

func localESCPOSDiagnosticPayload() []byte {
	// Cutter support is a separate capability and cannot be inferred from
	// ESC/POS itself. Keep the local diagnostic to initialization + printable
	// text/feeds; Gateway jobs may add a cut only when the payload explicitly
	// requests a supported peripheral action.
	return []byte("\x1b\x40Hello from Yaseir Agent!\n\n\n")
}

func (p *NetworkPrinter) Test(ctx context.Context) error {
	payload, err := localByteDiagnosticPayload(strings.ToLower(strings.TrimSpace(p.Protocol)))
	if err != nil {
		return err
	}
	testCtx, cancel := context.WithTimeout(ctx, testPrintDialTimeout)
	defer cancel()
	return p.printBytes(testCtx, payload, false, testPrintDialTimeout)
}

// Status differentiates transport reachability from device health:
//   - escpos devices are actively probed (DLE EOT). A device that answers
//     with paper-out/cover-open/offline reports "error"/"offline"; a device
//     that accepts TCP but never answers the status inquiry reports
//     "unknown", NEVER "online" (an unreadable status is not proof of
//     health).
//   - other transports (raw/zpl/tspl byte sinks) are write-only, so the
//     socket alone can only prove connectivity. When the device also
//     answers the standard SNMP Host-Resources printer table, that
//     answer IS device state (paper out, jam, door open, toner, idle /
//     printing) and decides the status (see snmp_status.go). When it
//     does not answer, the status stays "unknown" on a live socket.
//     Definite connection refusal is "offline". Delivery still uses
//     pre-dispatch dial failure detection and UNKNOWN_PARTIAL_DELIVERY
//     classification on mid-stream writes.
func (p *NetworkPrinter) Status() string {
	conn, err := net.DialTimeout("tcp", p.Address, 2*time.Second)
	if err != nil {
		p.setStatusDetail("")
		return "offline"
	}
	if !strings.EqualFold(strings.TrimSpace(p.Protocol), "escpos") {
		_ = conn.Close()
		if status, detail := p.snmpStatus(); status != "" {
			p.setStatusDetail(detail)
			return status
		}
		p.setStatusDetail("")
		return "unknown"
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(1500 * time.Millisecond)); err != nil {
		return "error"
	}
	if _, err := QueryHealthStatus(conn); err != nil {
		var netErr net.Error
		if errors.Is(err, ErrPrinterStatusUnsupported) || (errors.As(err, &netErr) && netErr.Timeout()) {
			return "unknown"
		}
		if errors.Is(err, ErrPrinterOffline) {
			return "offline"
		}
		return "error"
	}
	return "online"
}

// snmpStatus reads device state through the SNMP Host-Resources
// printer table when the device offers it. A miss is negatively
// cached (snmpMissUntil) so non-SNMP devices pay the probe timeout at
// most once per cache window instead of on every status cycle.
func (p *NetworkPrinter) snmpStatus() (status, detail string) {
	p.statusMu.RLock()
	missUntil := p.snmpMissUntil
	p.statusMu.RUnlock()
	if time.Now().Before(missUntil) {
		return "", ""
	}
	host := p.Address
	if h, _, err := net.SplitHostPort(p.Address); err == nil {
		host = h
	}
	status, detail, ok := snmpStatusProbe(context.Background(), host)
	if !ok {
		p.statusMu.Lock()
		p.snmpMissUntil = time.Now().Add(snmpStatusUnsupportedCacheFor)
		p.statusMu.Unlock()
		return "", ""
	}
	return status, detail
}

func (p *NetworkPrinter) PrinterGeometry(ctx context.Context) (*Geometry, error) {
	if err := p.Geometry.Validate(); err != nil {
		return nil, err
	}
	return p.Geometry, nil
}
