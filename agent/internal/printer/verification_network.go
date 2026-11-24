package printer

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
)

func (p *NetworkPrinter) VerifyOperational(ctx context.Context, cfg config.PrinterConfig) (*OperationalVerification, error) {
	if !verificationEndpointMatches(cfg, p.Address, "") || cfg.NormalizedProtocolOrUnknown() != strings.ToLower(strings.TrimSpace(p.Protocol)) {
		return nil, fmt.Errorf("TCP backend and selected destination/protocol differ")
	}
	host, portText, err := net.SplitHostPort(p.Address)
	port, portErr := strconv.Atoi(portText)
	if err != nil || portErr != nil {
		return nil, fmt.Errorf("invalid TCP printer destination")
	}
	observation, ok := probeSNMPPrinterWithPort(ctx, host, 161, port)
	if !ok || observation.Capabilities["print_endpoint_verified"] != true {
		return nil, fmt.Errorf("TCP connection alone does not establish a printer; verified Printer-MIB identification is required")
	}
	name, _ := observation.Capabilities["printer_mib_name"].(string)
	serial, _ := observation.Capabilities["serial"].(string)
	description, _ := observation.Capabilities["sysDescr"].(string)
	if !usableIdentityValue(name) || !usableIdentityValue(serial) || !usableIdentityValue(description) ||
		len(name) > 255 || len(serial) > 255 || len(description) > 1024 {
		return nil, fmt.Errorf("Printer-MIB response lacks bounded device identification; candidate remains pending")
	}
	// The serial is device-reported, scoped by the observed model description.
	// It is descriptive evidence only; it never merges logical TCP channels.
	physical := operationalIdentityDigest("snmp-printer:" + serial + "\x00" + description)
	return NewOperationalVerification(cfg, "snmp_printer", "device", physical, "physical")
}
