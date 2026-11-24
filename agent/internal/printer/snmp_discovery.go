package printer

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

const (
	oidSysDescr               = "1.3.6.1.2.1.1.1.0"
	oidPrtGeneralPrinterName  = "1.3.6.1.2.1.43.5.1.1.16.1"
	oidPrtGeneralSerialNumber = "1.3.6.1.2.1.43.5.1.1.17.1"
)

var snmpPrinterKeywords = []string{
	// NOTE: keep these specific. Short substrings like "pos" or "star"
	// false-positive on ordinary sysDescr text ("composite", "restart",
	// "post", ...), which would list random network gear as printers.
	"printer",
	"laserjet",
	"pagepro",
	"epson",
	"zebra",
	"tsc",
	"receipt",
	"thermal",
	"label",
	"bixolon",
	"xprinter",
	"intermec",
	"citizen",
}

// probeSNMPPrinter probes the given IP address on UDP port 161 for printer SNMP MIBs.
func probeSNMPPrinter(ctx context.Context, ip string) (DeviceInfo, bool) {
	return probeSNMPPrinterWithPort(ctx, ip, 161, 9100)
}

// snmpClient builds one bounded SNMPv2c read session (community
// "public": the Agent's read-only posture everywhere; never a
// configured private credential). gosnmp waits up to Timeout per
// attempt and then retries, so the context budget must cover every
// attempt: sizing it to a single attempt silently cancels the retry
// mid-flight and makes Retries dead configuration. Every SNMP probe
// in this package shares this budget rule — it lives in exactly one
// place so a future probe cannot re-derive it wrong.
func snmpClient(ctx context.Context, target string, port uint16, timeout time.Duration, retries int) (*gosnmp.GoSNMP, context.CancelFunc) {
	probeCtx, cancel := context.WithTimeout(ctx, timeout*time.Duration(retries+1))
	return &gosnmp.GoSNMP{
		Target:    target,
		Port:      port,
		Community: "public",
		Version:   gosnmp.Version2c,
		Timeout:   timeout,
		Retries:   retries,
		Context:   probeCtx,
	}, cancel
}

// probeSNMPPrinterWithPort probes the given IP and SNMP port, populating DeviceInfo with printerPort.
func probeSNMPPrinterWithPort(ctx context.Context, ip string, snmpPort int, printerPort int) (DeviceInfo, bool) {
	if snmpPort <= 0 {
		snmpPort = 161
	}
	if printerPort <= 0 {
		printerPort = 9100
	}

	const (
		snmpProbeTimeout = 600 * time.Millisecond
		snmpProbeRetries = 1
	)
	params, cancel := snmpClient(ctx, ip, uint16(snmpPort), snmpProbeTimeout, snmpProbeRetries)
	defer cancel()

	if err := params.Connect(); err != nil {
		return DeviceInfo{}, false
	}
	defer params.Conn.Close()

	oids := []string{oidSysDescr, oidPrtGeneralPrinterName, oidPrtGeneralSerialNumber}
	result, err := params.Get(oids)
	if err != nil || result == nil || result.Error != gosnmp.NoError || len(result.Variables) == 0 {
		// Fallback: try querying sysDescr alone in case device errors on printer MIB OIDs
		result, err = params.Get([]string{oidSysDescr})
		if err != nil || result == nil || result.Error != gosnmp.NoError || len(result.Variables) == 0 {
			return DeviceInfo{}, false
		}
	}

	var sysDescr, prtPrinterName, prtSerial string
	for _, pdu := range result.Variables {
		name := strings.TrimPrefix(pdu.Name, ".")
		val := extractSNMPPDUString(pdu)
		switch name {
		case oidSysDescr:
			sysDescr = val
		case oidPrtGeneralPrinterName:
			prtPrinterName = val
		case oidPrtGeneralSerialNumber:
			prtSerial = val
		}
	}

	sysDescrLower := strings.ToLower(sysDescr)
	isPrinter := false
	if strings.TrimSpace(prtPrinterName) != "" {
		isPrinter = true
	} else {
		for _, kw := range snmpPrinterKeywords {
			if strings.Contains(sysDescrLower, kw) {
				isPrinter = true
				break
			}
		}
	}

	if !isPrinter {
		return DeviceInfo{}, false
	}

	name := strings.TrimSpace(prtPrinterName)
	if name == "" {
		name = strings.TrimSpace(sysDescr)
	}
	if name == "" {
		name = fmt.Sprintf("SNMP Printer %s", ip)
	}

	// SNMP identifies the device as a printer, but it does not prove that
	// TCP printerPort is enabled. Verify that transport separately before
	// assigning an endpoint/protocol that the print pipeline could use.
	printEndpointVerified := verifyTCPPrintEndpoint(ctx, ip, printerPort)
	caps := map[string]interface{}{
		"discovered_via":   SourceSNMP,
		"sysDescr":         sysDescr,
		"printer_mib_name": prtPrinterName,
		"serial":           prtSerial,
		"snmp_detected":    true,
	}
	protocol := ""
	endpoint := ip
	port := 0
	status := "unknown"
	if printEndpointVerified {
		protocol = inferSNMPProtocol(sysDescrLower, strings.ToLower(name))
		endpoint = net.JoinHostPort(ip, strconv.Itoa(printerPort))
		port = printerPort
		// Reachable TCP and an SNMP identity query are not hardware-ready
		// evidence (paper, cover and printer-state are unobserved).
		status = "unknown"
		caps["snmp_verified"] = true
		caps["print_endpoint_verified"] = true
	} else {
		caps["verification"] = "device_detected_only"
	}

	// The identity must be derived from the device, not from what happened to
	// be reachable at probe time.
	//
	// `printEndpointVerified` is a live TCP observation: a printer that is
	// asleep, busy, or behind a filtered port fails it. Previously the ID was
	// built from `endpoint`/`Port`, which differ across that flap — reachable
	// gave "ip:9100"/9100 (StableIDFromNetwork) and unreachable gave bare
	// "ip"/0, which falls through to StableIDFromEndpoint. One physical printer
	// therefore produced two IDs and was inventoried twice, with duplicates
	// accumulating every time the port flapped. The intended print port is
	// known regardless, so pin the identity to it.
	idInput := DeviceInfo{
		NetworkAddress: ip,
		Port:           printerPort, // non-zero in both branches: keeps one namespace
		Endpoint:       endpoint,
		Name:           name,
	}
	di := DeviceInfo{
		ID:             StableIDForDevice(idInput),
		Name:           name,
		DisplayName:    name,
		PrinterType:    "unknown",
		ConnectionType: "network",
		Protocol:       protocol,
		Endpoint:       endpoint,
		NetworkAddress: ip,
		Port:           port,
		Status:         status,
		Enabled:        true,
		Type:           "network",
		Capabilities:   caps,
	}

	return di, true
}

func verifyTCPPrintEndpoint(ctx context.Context, ip string, port int) bool {
	if port <= 0 {
		return false
	}
	d := net.Dialer{Timeout: 500 * time.Millisecond}
	probeCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	conn, err := d.DialContext(probeCtx, "tcp", net.JoinHostPort(ip, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func extractSNMPPDUString(pdu gosnmp.SnmpPDU) string {
	// Identity objects are OCTET STRINGs; coercing another BER type invents evidence.
	if pdu.Type != gosnmp.OctetString {
		return ""
	}
	switch val := pdu.Value.(type) {
	case string:
		return strings.TrimSpace(val)
	case []byte:
		return strings.TrimSpace(string(val))
	default:
		return ""
	}
}

func inferSNMPProtocol(sysDescrLower, nameLower string) string {
	combined := sysDescrLower + " " + nameLower
	// Device class, brand, or marketing terms (thermal/receipt/Zebra/TSC/Star)
	// do not prove an executable printer language. Promote a byte protocol
	// only when the device evidence explicitly names that language.
	switch {
	case strings.Contains(combined, "zpl"):
		return "zpl"
	case strings.Contains(combined, "tspl"):
		return "tspl"
	case strings.Contains(combined, "escpos") || strings.Contains(combined, "esc/pos"):
		return "escpos"
	default:
		return "unknown"
	}
}
