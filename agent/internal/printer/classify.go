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
