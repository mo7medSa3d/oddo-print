//go:build !windows

package printer

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode"
)

func enumSpoolerPrintersPlatform() ([]DeviceInfo, error) {
	// On Linux/macOS, discover CUPS queues (including virtual PDF printers such
	// as CUPS-PDF, Save as PDF, and Print to File) when lpstat is available.
	lpstatPath, err := exec.LookPath("lpstat")
	if err != nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, lpstatPath, "-v")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "LANG=C")
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return nil, nil
	}

	var devices []DeviceInfo
	for _, rawLine := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(rawLine)
		// Standard CUPS output: "device for <queue>: <uri>"
		const prefix = "device for "
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		rest := line[len(prefix):]
		colonIdx := strings.Index(rest, ":")
		if colonIdx <= 0 {
			continue
		}
		name := strings.TrimSpace(rest[:colonIdx])
		uri := strings.TrimSpace(rest[colonIdx+1:])
		if name == "" || strings.HasPrefix(name, "-") || strings.ContainsFunc(name, unicode.IsControl) {
			continue
		}
		cls := ClassifyDevice(DeviceFacts{
			Name:           name,
			DisplayName:    name,
			SpoolerName:    name,
			PortName:       uri,
			ConnectionType: "spooler",
			Protocol:       "spooler",
		})
		if cls.IsRedirected || cls.IsUnusable {
			continue
		}
		printerType := "unknown"
		if cls.IsVirtual {
			printerType = "virtual"
		}
		caps := map[string]interface{}{
			"discovered_via": SourceSpooler,
			"port_name":      uri,
			"is_virtual":     cls.IsVirtual,
			"printer_class":  string(cls.Class),
		}
		devices = append(devices, DeviceInfo{
			Name:           name,
			DisplayName:    name,
			PrinterType:    printerType,
			ConnectionType: "spooler",
			Protocol:       "spooler",
			Endpoint:       name,
			SpoolerName:    name,
			SpoolerPort:    uri,
			Status:         "online",
			Enabled:        true,
			IsVirtual:      cls.IsVirtual,
			Capabilities:   caps,
		})
	}
	return devices, nil
}
