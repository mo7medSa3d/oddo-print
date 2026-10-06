package printer

import (
	"fmt"
	"strings"
)

func isPrinterUSBDevice(hwIDs, compatIDs []string, classVal string) bool {
	combined := strings.ToUpper(strings.Join(append(append([]string{}, hwIDs...), compatIDs...), " "))
	classUpper := strings.ToUpper(strings.TrimSpace(classVal))
	if strings.Contains(combined, "USBPRINT") {
		return true
	}
	if strings.Contains(combined, "USB\\CLASS_07") {
		return true
	}
	if strings.Contains(combined, "CLASS_07") && strings.Contains(combined, "USB") {
		return true
	}
	if classUpper == "07" || classUpper == "PRINTER" {
		return true
	}
	if strings.Contains(classUpper, "07") && strings.Contains(classUpper, "USB") {
		return true
	}
	if strings.Contains(combined, "PRINTER") && strings.Contains(combined, "USB") {
		return true
	}
	return false
}

func isValidSpoolerPrinter(portName, driverName, printerName string) bool {
	if strings.TrimSpace(printerName) == "" {
		return false
	}
	lowerName := spoolerToLowerTrim(printerName)
	lowerDriver := spoolerToLowerTrim(driverName)
	// Generic PnP / non-printer devices must never be surfaced as spooler printers,
	// even if EnumPrintersW somehow enumerates them or they were persisted in registry.
	genericSubstrings := []string{
		"usb input device",
		"usb composite device",
		"hid-compliant",
		"hid compliant",
		"standard system devices",
		"standard usb host controller",
		"intel(r) wireless bluetooth",
		"wireless bluetooth",
		"bluetooth adapter",
		"fingerprint sensor",
		"touch fingerprint",
		"synaptics",
		"vfs7552",
		"hd camera",
		"hp hd camera",
		"camera",
		"usb hub",
		"generic usb hub",
	}
	for _, g := range genericSubstrings {
		if strings.Contains(lowerName, g) || strings.Contains(lowerDriver, g) {
			// If driver explicitly indicates printer (printer/laser/inkjet/thermal etc.), keep it;
			// otherwise it's not a printer queue. Note: check "printer" not just "print"
			// to avoid false positive on "fingerprint" containing "print".
			if !strings.Contains(lowerDriver, "printer") && !strings.Contains(lowerDriver, "laser") && !strings.Contains(lowerDriver, "inkjet") && !strings.Contains(lowerDriver, "thermal") && !strings.Contains(lowerDriver, "label") && !strings.Contains(lowerDriver, "zebra") && !strings.Contains(lowerName, "printer") {
				return false
			}
		}
	}
	// Also reject if driver is empty and name is generic USB device without printer keywords
	if strings.TrimSpace(driverName) == "" && strings.Contains(lowerName, "usb") && strings.Contains(lowerName, "device") {
		if !strings.Contains(lowerName, "printer") && !strings.Contains(lowerName, "print") {
			return false
		}
	}
	return true
}

// isVirtualSpooler reports whether a Windows spooler queue is software-only.
// It is used before a queue enters the managed printer inventory.
func isVirtualSpooler(portName, driverName, printerName string) bool {
	return ClassifyDevice(DeviceFacts{
		Name:       printerName,
		DriverName: driverName,
		PortName:   portName,
	}).IsVirtual
}

// classifySpoolerPrinter infers printerType and connectionType from PortName and DriverName.
// Pure function, no Windows API, testable on all platforms.
//
// A Windows print queue is ALWAYS served through the Windows spooler backend,
// regardless of its port (USB001, WSD, IP_*, BRN_*, LPT1:, shared \\server\,
// vendor monitors). The port/monitor select the spooler's delivery path; they
// never turn the queue into a direct-TCP or direct-USB device. Direct network
// (RAW 9100) and direct USB (device path) transports are separate,
// operator-declared printer records — never inferred from a queue's port
// name. Inferring "network"/"usb"/"local" here previously broke every WSD and
// Standard TCP/IP queue: the factory expects ip:port endpoints for network
// printers, so those queues failed to initialize and never heartbeated.
func classifySpoolerPrinter(portName, driverName, printerName string) (printerType, connectionType string) {
	// Connection is always the Windows spooler for an installed queue.
	connectionType = "spooler"

	driverLower := spoolerToLowerTrim(driverName)
	nameLower := spoolerToLowerTrim(printerName)

	switch {
	case strings.Contains(driverLower, "thermal") || strings.Contains(nameLower, "thermal") || strings.Contains(nameLower, "receipt") || strings.Contains(nameLower, "pos") || strings.Contains(driverLower, "escpos") || strings.Contains(driverLower, "epson tm-") || strings.Contains(driverLower, "bixolon"):
		printerType = "thermal"
	case strings.Contains(driverLower, "label") || strings.Contains(nameLower, "label") || strings.Contains(driverLower, "zebra") || strings.Contains(driverLower, "zdesigner"):
		printerType = "label"
	case strings.Contains(driverLower, "laser") || strings.Contains(nameLower, "laserjet") || strings.Contains(driverLower, "laserjet"):
		printerType = "laser"
	case strings.Contains(driverLower, "inkjet") || strings.Contains(driverLower, "deskjet") || strings.Contains(driverLower, "officejet"):
		printerType = "inkjet"
	default:
		printerType = "unknown"
	}
	return
}

// mapWindowsStatus converts Windows spooler status bits into the Gateway
// status vocabulary, failing closed for unmodelled status bits.
func mapWindowsStatus(status uint32, attributes uint32) string {
	const (
		PRINTER_STATUS_PAUSED            = 0x00000001
		PRINTER_STATUS_ERROR             = 0x00000002
		PRINTER_STATUS_PENDING_DELETION  = 0x00000004
		PRINTER_STATUS_PAPER_JAM         = 0x00000008
		PRINTER_STATUS_PAPER_OUT         = 0x00000010
		PRINTER_STATUS_MANUAL_FEED       = 0x00000020
		PRINTER_STATUS_PAPER_PROBLEM     = 0x00000040
		PRINTER_STATUS_OFFLINE           = 0x00000080
		PRINTER_STATUS_IO_ACTIVE         = 0x00000100
		PRINTER_STATUS_BUSY              = 0x00000200
		PRINTER_STATUS_PRINTING          = 0x00000400
		PRINTER_STATUS_OUTPUT_BIN_FULL   = 0x00000800
		PRINTER_STATUS_NOT_AVAILABLE     = 0x00001000
		PRINTER_STATUS_WAITING           = 0x00002000
		PRINTER_STATUS_PROCESSING        = 0x00004000
		PRINTER_STATUS_INITIALIZING      = 0x00008000
		PRINTER_STATUS_WARMING_UP        = 0x00010000
		PRINTER_STATUS_TONER_LOW         = 0x00020000
		PRINTER_STATUS_NO_TONER          = 0x00040000
		PRINTER_STATUS_PAGE_PUNT         = 0x00080000
		PRINTER_STATUS_USER_INTERVENTION = 0x00100000
		PRINTER_STATUS_OUT_OF_MEMORY     = 0x00200000
		PRINTER_STATUS_DOOR_OPEN         = 0x00400000
		PRINTER_STATUS_SERVER_UNKNOWN    = 0x00800000
		PRINTER_STATUS_POWER_SAVE        = 0x01000000
		PRINTER_STATUS_SERVER_OFFLINE    = 0x02000000
	)
	const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400
	// Definitive queue/device states outrank SERVER_UNKNOWN when drivers report
	// combinations of bits. Only a bare/inconclusive SERVER_UNKNOWN becomes
	// "unknown"; it is not evidence that the printer is physically offline.
	if attributes&PRINTER_ATTRIBUTE_WORK_OFFLINE != 0 || status&PRINTER_STATUS_OFFLINE != 0 || status&PRINTER_STATUS_SERVER_OFFLINE != 0 || status&PRINTER_STATUS_NOT_AVAILABLE != 0 {
		return "offline"
	}
	if status&(PRINTER_STATUS_PENDING_DELETION|PRINTER_STATUS_PAUSED|PRINTER_STATUS_ERROR|PRINTER_STATUS_PAPER_JAM|PRINTER_STATUS_PAPER_OUT|PRINTER_STATUS_MANUAL_FEED|PRINTER_STATUS_PAPER_PROBLEM|PRINTER_STATUS_OUTPUT_BIN_FULL|PRINTER_STATUS_NO_TONER|PRINTER_STATUS_PAGE_PUNT|PRINTER_STATUS_USER_INTERVENTION|PRINTER_STATUS_OUT_OF_MEMORY|PRINTER_STATUS_DOOR_OPEN) != 0 {
		return "error"
	}
	if status&PRINTER_STATUS_BUSY != 0 || status&PRINTER_STATUS_IO_ACTIVE != 0 || status&PRINTER_STATUS_PRINTING != 0 || status&PRINTER_STATUS_PROCESSING != 0 {
		return "busy"
	}
	if status&PRINTER_STATUS_INITIALIZING != 0 || status&PRINTER_STATUS_WARMING_UP != 0 {
		return "busy"
	}
	if status&PRINTER_STATUS_SERVER_UNKNOWN != 0 {
		return "unknown"
	}
	const benignStatusBits = PRINTER_STATUS_WAITING | PRINTER_STATUS_TONER_LOW | PRINTER_STATUS_POWER_SAVE
	if status&^benignStatusBits == 0 {
		return "online"
	}
	return "unknown"
}

func spoolerToLowerTrim(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	s = s[start:end]
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
func spoolerHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
func spoolerIndexComma(s string) int {
	for i, c := range s {
		if c == ',' {
			return i
		}
	}
	return -1
}
func spoolerSplitPort(s string) (string, string, error) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == ':' {
			if i == 0 || i == len(s)-1 {
				break
			}
			host := s[:i]
			port := s[i+1:]
			for _, c := range port {
				if c < '0' || c > '9' {
					return "", "", fmt.Errorf("not host:port")
				}
			}
			return host, port, nil
		}
	}
	return "", "", fmt.Errorf("missing port")
}
func spoolerIsIPLike(s string) bool {
	parts := 0
	dots := 0
	for _, c := range s {
		if c == '.' {
			dots++
		} else if c >= '0' && c <= '9' {
			parts++
		} else {
			return false
		}
	}
	return dots == 3 && parts >= 4
}
