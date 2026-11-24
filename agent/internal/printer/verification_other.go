//go:build !windows

package printer

import (
	"context"
	"fmt"

	"github.com/yaseir-agent/agent/internal/config"
)

func (p *SpoolerPrinter) VerifyOperational(context.Context, config.PrinterConfig) (*OperationalVerification, error) {
	return nil, fmt.Errorf("Windows queue verification is unavailable on this operating system")
}

func (p *USBPrinter) VerifyOperational(context.Context, config.PrinterConfig) (*OperationalVerification, error) {
	return nil, fmt.Errorf("Windows USBPRINT interface verification is unavailable on this operating system")
}
