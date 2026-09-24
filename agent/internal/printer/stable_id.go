package printer

import (
	"crypto/sha256"
	"fmt"
	"net"
	"net/url"
	"strings"
)

func usableIdentityValue(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	switch v {
	case "", "0", "unknown", "none", "null", "n/a", "na", "-", "unavailable":
		return false
	default:
		return true
	}
}

func normalizeIdentityValue(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "urn:uuid:")
	return strings.ToLower(value)
}

func capabilityIdentityValue(d DeviceInfo, keys ...string) string {
	for _, key := range keys {
		if d.Capabilities == nil {
			continue
		}
		if value, ok := d.Capabilities[key]; ok {
			candidate := strings.TrimSpace(fmt.Sprint(value))
			if usableIdentityValue(candidate) {
				return normalizeIdentityValue(candidate)
			}
		}
	}
	return ""
}

func stableIDFromIdentityKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_identity_%x", h[:8])
}

// physicalIdentityKey returns a stable, source-independent identity when the
// discovery source exposes hardware/queue identity that survives endpoint/name
// changes. It deliberately does not fall back to IP, endpoint or display name.
func physicalIdentityKey(d DeviceInfo) (string, bool) {
	if uuid := capabilityIdentityValue(d, "uuid", "printer_uuid"); uuid != "" {
		return "uuid:" + uuid, true
	}

	if serial := capabilityIdentityValue(d, "serial"); serial != "" {
		manufacturer := capabilityIdentityValue(d, "manufacturer")
		model := capabilityIdentityValue(d, "model")
		return fmt.Sprintf("serial:%s|manufacturer:%s|model:%s", serial, manufacturer, model), true
	}

	if mac := capabilityIdentityValue(d, "mac", "mac_address", "macAddress"); mac != "" {
		return "mac:" + mac, true
	}

	if strings.TrimSpace(d.USBSerial) != "" && usableIdentityValue(d.USBSerial) {
		return "usb-serial:" + normalizeIdentityValue(d.USBSerial), true
	}

	spoolerPort := strings.ToLower(strings.TrimSpace(d.SpoolerPort))
	spoolerDriver := strings.ToLower(strings.TrimSpace(d.SpoolerDriver))
	if usableIdentityValue(spoolerPort) && usableIdentityValue(spoolerDriver) {
		server := strings.ToLower(strings.TrimSpace(d.SpoolerServer))
		share := strings.ToLower(strings.TrimSpace(d.SpoolerShare))
		return fmt.Sprintf("spooler:%s|port:%s|driver:%s|share:%s", server, spoolerPort, spoolerDriver, share), true
	}

	return "", false
}

// StableIDFromSpooler derives a deterministic printer ID from Windows spooler name.
// Kept for backwards compatibility with previously persisted IDs.
func StableIDFromSpooler(spoolerName string) string {
	norm := strings.ToLower(strings.TrimSpace(spoolerName))
	norm = strings.ReplaceAll(norm, " ", "_")
	h := sha256.Sum256([]byte("spooler:" + norm))
	return fmt.Sprintf("printer_spooler_%x", h[:8])
}

func StableIDFromSpoolerIdentity(server, port, driver, share string) string {
	key := fmt.Sprintf("spooler:%s|port:%s|driver:%s|share:%s",
		strings.ToLower(strings.TrimSpace(server)),
		strings.ToLower(strings.TrimSpace(port)),
		strings.ToLower(strings.TrimSpace(driver)),
		strings.ToLower(strings.TrimSpace(share)),
	)
	return stableIDFromIdentityKey(key)
}

// StableIDFromUSB derives a deterministic ID from USB identifiers.
// Priority: serial > location > VID:PID.
func StableIDFromUSB(vid, pid, serial, location string) string {
	var key string
	if serial != "" && usableIdentityValue(serial) {
		key = fmt.Sprintf("usb-sn:%s", normalizeIdentityValue(serial))
	} else if location != "" {
		key = fmt.Sprintf("usb-loc:%s", strings.ToLower(strings.TrimSpace(location)))
	} else {
		key = fmt.Sprintf("usb-vidpid:%s:%s", strings.ToLower(vid), strings.ToLower(pid))
	}
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_usb_%x", h[:8])
}

// StableIDFromNetwork derives a deterministic ID from IP and port.
// This is a fallback only when discovery exposes no durable device identity.
func StableIDFromNetwork(ip string, port int) string {
	host := strings.ToLower(strings.TrimSpace(ip))
	host = strings.Trim(host, "[]")
	if parsed := net.ParseIP(host); parsed != nil {
		host = parsed.String()
	}
	key := fmt.Sprintf("net:%s:%d", host, port)
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_net_%x", h[:8])
}

func StableIDFromEndpoint(endpoint string) string {
	key := fmt.Sprintf("endpoint:%s", strings.ToLower(strings.TrimSpace(endpoint)))
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_ep_%x", h[:8])
}

// StableIDForDevice returns a deterministic ID using the strongest available
// physical identity first. Endpoint/name fallbacks remain for devices that do
// not expose a durable identity.
func StableIDForDevice(d DeviceInfo) string {
	if key, ok := physicalIdentityKey(d); ok {
		// Keep the established USB ID namespace for serial-backed manual
		// registration. This preserves compatibility with existing bindings
		// while the physical identity key still lets registry reconciliation
		// recognize the same device across endpoint/name changes.
		if strings.HasPrefix(key, "usb-serial:") {
			return StableIDFromUSB(d.USBVID, d.USBPID, d.USBSerial, "")
		}
		return stableIDFromIdentityKey(key)
	}

	if d.SpoolerName != "" {
		return StableIDFromSpooler(d.SpoolerName)
	}
	if d.USBSerial != "" || d.USBVID != "" {
		return StableIDFromUSB(d.USBVID, d.USBPID, d.USBSerial, "")
	}
	if d.NetworkAddress != "" && d.Port != 0 {
		return StableIDFromNetwork(d.NetworkAddress, d.Port)
	}
	if d.Endpoint != "" {
		lowerEP := strings.ToLower(strings.TrimSpace(d.Endpoint))
		parseStr := d.Endpoint
		if strings.HasPrefix(lowerEP, "ipp://") {
			parseStr = "http://" + d.Endpoint[6:]
		} else if strings.HasPrefix(lowerEP, "ipps://") {
			parseStr = "https://" + d.Endpoint[7:]
		}
		if strings.HasPrefix(lowerEP, "ipp://") || strings.HasPrefix(lowerEP, "ipps://") || strings.HasPrefix(lowerEP, "http://") || strings.HasPrefix(lowerEP, "https://") {
			if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
				host := u.Hostname()
				port := 631
				if p := u.Port(); p != "" {
					fmt.Sscanf(p, "%d", &port)
				} else if u.Scheme == "https" {
					port = 443
				}
				if host != "" {
					return StableIDFromNetwork(host, port)
				}
			}
		}
		if host, portStr, err := net.SplitHostPort(d.Endpoint); err == nil {
			var port int
			fmt.Sscanf(portStr, "%d", &port)
			return StableIDFromNetwork(host, port)
		}
		return StableIDFromEndpoint(d.Endpoint)
	}

	h := sha256.Sum256([]byte("name:" + strings.ToLower(strings.TrimSpace(d.Name))))
	return fmt.Sprintf("printer_%x", h[:8])
}
