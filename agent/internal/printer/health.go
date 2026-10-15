package printer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

var (
	ErrPrinterNotReady  = errors.New("ERR_PRINTER_NOT_READY")
	ErrPrinterPaperOut  = fmt.Errorf("%w: ERR_PRINTER_PAPER_OUT", ErrPrinterNotReady)
	ErrPrinterOffline   = fmt.Errorf("%w: ERR_PRINTER_OFFLINE", ErrPrinterNotReady)
	ErrPrinterCoverOpen = fmt.Errorf("%w: ERR_PRINTER_COVER_OPEN", ErrPrinterNotReady)
	// ErrPrinterStatusUnsupported means the device accepted TCP but the
	// status inquiry produced no usable answer (unidirectional transport,
	// print server that swallows the back-channel, or a hung device).
	ErrPrinterStatusUnsupported = fmt.Errorf("%w: ERR_PRINTER_STATUS_UNSUPPORTED", ErrPrinterNotReady)
)

// ESC/POS DLE EOT status inquiry command bytes.
var (
	cmdInquirePrinterStatus = []byte{0x10, 0x04, 0x01}
	cmdInquireOfflineStatus = []byte{0x10, 0x04, 0x02}
	cmdInquirePaperStatus   = []byte{0x10, 0x04, 0x04}
)

// HealthStatus holds the detailed parsed hardware status flags of an ESC/POS printer.
type HealthStatus struct {
	Online       bool
	CoverOpen    bool
	PaperOut     bool
	PaperNearEnd bool
	Error        bool
}

// QueryHealthStatus inspects an active connection using ESC/POS DLE EOT sequences.
//
// Protocol verification note:
// In the ESC/POS specification, standard DLE EOT 1/2/4 response bytes have fixed bits:
// Bit 1 = 1, Bit 4 = 1, Bit 0 = 0, Bit 7 = 0 (mask 0x93 == 0x12).
// Any byte that fails this framing check indicates either garbage, non-ESC/POS device,
// or echo. Fault bits are meaningful only AFTER this framing check succeeds.
func QueryHealthStatus(rw io.ReadWriter) (*HealthStatus, error) {
	status := &HealthStatus{Online: true}

	// 1. Printer Status (DLE EOT 1)
	if n, err := rw.Write(cmdInquirePrinterStatus); err != nil || n != len(cmdInquirePrinterStatus) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return nil, fmt.Errorf("%w: failed to write printer status inquiry: %w", ErrPrinterOffline, err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read printer status: %w", ErrPrinterStatusUnsupported, err)
	}
	// Check standard ESC/POS DLE EOT response framing: bit 1=1, bit 4=1, bit 0=0, bit 7=0
	if (buf[0] & 0x93) != 0x12 {
		return nil, fmt.Errorf("%w: invalid ESC/POS printer status response byte 0x%02x (expected framing mask 0x93 == 0x12)", ErrPrinterStatusUnsupported, buf[0])
	}
	// Bit 3: Online (0) / Offline (1)
	if (buf[0] & 0x08) != 0 {
		status.Online = false
		return status, ErrPrinterOffline
	}

	// 2. Offline Status (DLE EOT 2)
	if n, err := rw.Write(cmdInquireOfflineStatus); err != nil || n != len(cmdInquireOfflineStatus) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return nil, fmt.Errorf("%w: failed to write offline status inquiry: %w", ErrPrinterOffline, err)
	}
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read offline status: %w", ErrPrinterStatusUnsupported, err)
	}
	if (buf[0] & 0x93) != 0x12 {
		return nil, fmt.Errorf("%w: invalid ESC/POS offline status response byte 0x%02x (expected framing mask 0x93 == 0x12)", ErrPrinterStatusUnsupported, buf[0])
	}
	// Bit 2: Cover open (1)
	if (buf[0] & 0x04) != 0 {
		status.CoverOpen = true
		return status, ErrPrinterCoverOpen
	}
	// Bit 5: Paper end stops printing (1)
	if (buf[0] & 0x20) != 0 {
		status.PaperOut = true
		return status, ErrPrinterPaperOut
	}
	// Bit 6: Error condition (1)
	if (buf[0] & 0x40) != 0 {
		status.Error = true
		return status, ErrPrinterOffline
	}

	// 3. Paper Status (DLE EOT 4)
	if n, err := rw.Write(cmdInquirePaperStatus); err != nil || n != len(cmdInquirePaperStatus) {
		if err == nil {
			err = io.ErrShortWrite
		}
		return nil, fmt.Errorf("%w: failed to write paper status inquiry: %w", ErrPrinterOffline, err)
	}
	if _, err := io.ReadFull(rw, buf); err != nil {
		return nil, fmt.Errorf("%w: failed to read paper status: %w", ErrPrinterStatusUnsupported, err)
	}
	if (buf[0] & 0x93) != 0x12 {
		return nil, fmt.Errorf("%w: invalid ESC/POS paper status response byte 0x%02x (expected framing mask 0x93 == 0x12)", ErrPrinterStatusUnsupported, buf[0])
	}
	// Each sensor is encoded as a pair: only 00 and 11 are defined. A
	// half-pair is not evidence of a hardware fault, even with valid framing.
	nearEnd := buf[0] & 0x0C
	paperEnd := buf[0] & 0x60
	if (nearEnd != 0 && nearEnd != 0x0C) || (paperEnd != 0 && paperEnd != 0x60) {
		return nil, fmt.Errorf("%w: invalid ESC/POS paper sensor pairs in response byte 0x%02x", ErrPrinterStatusUnsupported, buf[0])
	}
	// Bits 2 and 3: Paper roll near-end sensor
	if nearEnd == 0x0C {
		status.PaperNearEnd = true
	}
	// Bits 5 and 6: Paper roll end sensor (paper out when bits 5 & 6 are 1 -> 0x60)
	if paperEnd == 0x60 {
		status.PaperOut = true
		return status, ErrPrinterPaperOut
	}

	return status, nil
}

// PreFlightHealthCheck dials the printer address and verifies online and paper status.
// Returns nil if printer is ready, or a typed error (ErrPrinterPaperOut, ErrPrinterOffline, ErrPrinterCoverOpen).
func PreFlightHealthCheck(ctx context.Context, address string) error {
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("%w: dial %s: %w", ErrPrinterOffline, address, err)
	}
	defer conn.Close()
	stopCancellation := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancellation()

	deadline := time.Now().Add(1500 * time.Millisecond)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return fmt.Errorf("set printer health deadline: %w", err)
	}

	_, err = QueryHealthStatus(conn)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
