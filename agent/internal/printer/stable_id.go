package printer

import (
	"crypto/sha256"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// normalizeUnicode folds a string to its canonical composed form (NFC) before
// it is used as identity input.
//
// This matters for non-ASCII queue names. Unicode allows the same visible text
// to be encoded two ways: composed (NFC, one code point per accented/marked
// letter) or decomposed (NFD, base letter plus a combining mark). Arabic is
// especially exposed because diacritics such as shadda (U+0651) are separate
// combining marks, and a name copied from a source that emits NFD — macOS
// filesystems and many web forms do — is byte-different from the NFC form
// Windows itself returns.
//
// Without this fold, hashing the two encodings produces two different stable
// IDs, so one physical printer is inventoried twice: duplicated in the
// dashboard, duplicated in heartbeats, and able to receive the same job on two
// bindings. Folding to NFC is a no-op for strings already in NFC, so existing
// IDs are preserved.
//
// See https://unicode.org/reports/tr15/ and
// https://learn.microsoft.com/en-us/windows/win32/intl/using-unicode-normalization-to-represent-strings
func normalizeUnicode(value string) string {
	if value == "" {
		return ""
	}
	// Fast path: norm.NFC.IsNormalString is allocation-free, and the
	// overwhelming majority of names from Windows APIs are already NFC.
	if norm.NFC.IsNormalString(value) {
		return value
	}
	return norm.NFC.String(value)
}

func usableIdentityValue(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	switch v {
	case "", "0", "unknown", "none", "null", "n/a", "na", "-", "unavailable", "00000000-0000-0000-0000-000000000000":
		return false
	default:
		return true
	}
}

func normalizeIdentityValue(value string) string {
	// Fold the URN prefix before removing it: discovery sources may spell
	// the same UUID as urn:uuid:, URN:UUID: or as a bare identifier.
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "urn:uuid:")
	value = normalizeUnicode(value)
	return value
}

func capabilityIdentityValue(d DeviceInfo, keys ...string) string {
	for _, key := range keys {
		if d.Capabilities == nil {
			continue
		}
		if value, ok := d.Capabilities[key].(string); ok {
			// JSON nulls, booleans and objects are missing identity evidence,
			// not shared serials such as "<nil>" or "false". Formatting them
			// into a key can collapse unrelated physical destinations.
			// Validate after canonicalization: stripping a URN prefix can
			// expose an empty/placeholder UUID. It cannot prove that two
			// distinct endpoints are the same physical destination.
			candidate := normalizeIdentityValue(value)
			if key == "uuid" || key == "printer_uuid" {
				// Discovery can expose nil UUIDs as braced GUIDs or compact
				// hex too. Reject only missing UUID evidence; do not rewrite
				// valid UUIDs/serials or change established external IDs.
				compact := strings.ReplaceAll(strings.Trim(candidate, "{}"), "-", "")
				if compact == "00000000000000000000000000000000" {
					continue
				}
			}
			if usableIdentityValue(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func stableIDFromIdentityKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_identity_%x", h[:8])
}

// Hardware identity alone is insufficient on an IPP multi-queue server.
// Preserve resource path case/query while allowing host/address changes.
func ippQueueIdentitySuffix(d DeviceInfo) string {
	protocol := strings.ToLower(d.Protocol)
	connection := strings.ToLower(d.ConnectionType)
	if protocol != "ipp" && protocol != "ipps" && connection != "ipp" && connection != "ipps" {
		return ""
	}
	u, err := url.Parse(d.Endpoint)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	transport := ""
	switch strings.ToLower(u.Scheme) {
	case "ipps", "https":
		// TLS and plaintext are distinct execution bindings even when a
		// legacy record has no NetworkAddress/Port for StableIDFromIPPURI.
		transport = "|ipp-transport:ipps"
	}
	return transport + "|ipp-resource:" + path + "?" + u.RawQuery
}

// WSD ProbeMatches are unauthenticated discovery hints, not a proven chassis
// identity or an executable print transport. Different devices can advertise
// the same EndpointReference/UUID. Keep discovery-only records scoped to the
// observed endpoint and network peer until a real printer protocol is verified.
func isUnverifiedWSDObservation(d DeviceInfo) bool {
	return d.Capabilities["wsd_detected"] == true && d.Port == 0 &&
		(strings.TrimSpace(d.Protocol) == "" || strings.EqualFold(d.Protocol, "unknown"))
}

func wsdObservationIdentity(d DeviceInfo) string {
	if strings.TrimSpace(d.NetworkAddress) == "" {
		return ""
	}
	return "wsd-peer:" + normalizeIdentityValue(d.NetworkAddress) +
		"|endpoint:" + strings.TrimSpace(d.Endpoint) +
		"|reference:" + capabilityIdentityValue(d, "endpoint_reference")
}

// physicalIdentityKey is the legacy reconciliation key. For Windows it is
// explicitly a logical queue identity, never a chassis identity: two queues
// can share one driver and port while choosing different forms or settings.
// A directory-service GUID can preserve a published queue across a rename.
// Without one, only the actual queue/server tuple may establish continuity.
func physicalIdentityKey(d DeviceInfo) (string, bool) {
	if isSpoolerDevice(d) {
		if guid := verifiedWindowsQueueGUID(d); guid != "" {
			return "windows-queue-guid:" + guid, true
		}
		queue := strings.TrimSpace(d.SpoolerName)
		if queue == "" {
			queue = strings.TrimSpace(d.Endpoint)
		}
		if queue == "" {
			return "", false
		}
		return fmt.Sprintf("windows-queue:%s|server:%s|scope:%s", normalizeIdentityValue(queue),
			spoolerDetailValue(d, d.SpoolerServer, "server_name"), capabilityIdentityValue(d, "spooler_scope")), true
	}
	if isUnverifiedWSDObservation(d) {
		// Do not promote a self-reported multicast UUID into durable hardware
		// identity used by the registry to rebind another printer.
		return "", false
	}
	// An unauthenticated WSD UUID remains an observation even if another
	// discoverer later enriches this row with a usable print protocol. Only
	// the independently proven IPP UUID may become identity evidence here.
	if d.Capabilities["wsd_detected"] == true {
		if uuid := verifiedIPPUUIDFromCapabilities(d.Capabilities); uuid != "" {
			return "uuid:" + uuid + ippQueueIdentitySuffix(d), true
		}
	} else if uuid := capabilityIdentityValue(d, "uuid", "printer_uuid"); uuid != "" {
		return "uuid:" + uuid + ippQueueIdentitySuffix(d), true
	}

	if serial := capabilityIdentityValue(d, "serial"); serial != "" {
		manufacturer := capabilityIdentityValue(d, "manufacturer")
		model := capabilityIdentityValue(d, "model")
		return fmt.Sprintf("serial:%s|manufacturer:%s|model:%s", serial, manufacturer, model) + ippQueueIdentitySuffix(d), true
	}

	if mac := capabilityIdentityValue(d, "mac", "mac_address", "macAddress"); mac != "" {
		return "mac:" + mac + ippQueueIdentitySuffix(d), true
	}

	if strings.TrimSpace(d.USBSerial) != "" && usableIdentityValue(d.USBSerial) {
		serial := normalizeIdentityValue(d.USBSerial)
		vid := normalizeIdentityValue(d.USBVID)
		pid := normalizeIdentityValue(d.USBPID)
		if usableIdentityValue(vid) && usableIdentityValue(pid) {
			return fmt.Sprintf("usb-serial:%s:%s:%s", vid, pid, serial), true
		}
		// WP3 (STATIC REVIEW ONLY, B3-05): a serial on its own is NOT a
		// device identity when device-specific evidence exists. Two
		// distinct units can report the same short serial (or the same
		// vendor placeholder that usableIdentityValue does not know), so
		// returning a serial-only key here would merge them before the
		// instance/location/interface evidence below is ever consulted.
		// Only legacy/manual records with no other evidence keep the
		// serial-only fallback; anything with an instance ID, location,
		// interface path or USB endpoint path falls through so
		// StableIDForDevice can use that device-specific evidence (or
		// refuse to register, rather than merge).
		if capabilityIdentityValue(d, "device_instance_id", "location", "device_path") != "" {
			return "", false
		}
		if endpoint := normalizeIdentityValue(d.Endpoint); usableIdentityValue(endpoint) &&
			(strings.HasPrefix(endpoint, `\\?\usb`) || strings.HasPrefix(endpoint, `\\.\usb`)) {
			return "", false
		}
		// Some legacy/manual discovery records expose only the serial.
		// Keep the serial-only fallback for compatibility with those records.
		return "usb-serial:" + serial, true
	}

	return "", false
}

func verifiedWindowsQueueGUID(d DeviceInfo) string {
	if d.Capabilities["windows_queue_guid_verified"] != true {
		return ""
	}
	guid, _ := d.Capabilities["windows_queue_guid"].(string)
	guid = strings.Trim(strings.TrimSpace(guid), "{}")
	guid = strings.TrimPrefix(strings.ToLower(guid), "urn:uuid:")
	return normalizedIPPPrinterUUID("urn:uuid:" + guid)
}

// spoolerDetailValue accepts both current first-class fields and older
// capability-only registry records. It is identity evidence, not live health.
func spoolerDetailValue(d DeviceInfo, field, capability string) string {
	if usableIdentityValue(field) {
		return normalizeIdentityValue(field)
	}
	return capabilityIdentityValue(d, capability)
}

// sameSpoolerQueueDuringDetailLoss is a narrow continuity fallback, not a
// display-name or physical-printer matcher. EnumPrinters' queue/server still
// identify the same local transport when optional GetPrinter details disappear.
// Driver and port are mutable queue settings. Their changes require fresh
// operational verification, but cannot create a second logical queue record.
func sameSpoolerQueueDuringDetailLoss(a, b DeviceInfo) bool {
	isSpooler := func(d DeviceInfo) bool {
		return strings.EqualFold(d.Protocol, "spooler") ||
			strings.EqualFold(d.ConnectionType, "spooler") ||
			strings.EqualFold(d.ConnectionType, "windows_spooler")
	}
	if !isSpooler(a) || !isSpooler(b) || !usableIdentityValue(a.SpoolerName) || !usableIdentityValue(b.SpoolerName) {
		return false
	}
	// Do not fold spaces into underscores as the legacy ID hash does: these
	// may be two distinct queue names. Never substitute a display name.
	if normalizeIdentityValue(a.SpoolerName) != normalizeIdentityValue(b.SpoolerName) {
		return false
	}
	serverA := spoolerDetailValue(a, a.SpoolerServer, "server_name")
	serverB := spoolerDetailValue(b, b.SpoolerServer, "server_name")
	if serverA != serverB {
		return false
	}
	scopeA := capabilityIdentityValue(a, "spooler_scope")
	scopeB := capabilityIdentityValue(b, "spooler_scope")
	if scopeA != "" && scopeB != "" && scopeA != scopeB {
		return false
	}
	guidA, guidB := verifiedWindowsQueueGUID(a), verifiedWindowsQueueGUID(b)
	if guidA != "" && guidB != "" && guidA != guidB {
		return false
	}
	return true
}

// StableIDFromSpooler derives a deterministic printer ID from Windows spooler name.
// Kept for backwards compatibility with previously persisted IDs.
func StableIDFromSpooler(spoolerName string) string {
	name := normalizeUnicode(strings.TrimSpace(spoolerName))
	name = strings.ToLower(name)
	name = strings.ReplaceAll(name, " ", "_")
	h := sha256.Sum256([]byte("spooler:" + name))
	return fmt.Sprintf("printer_spooler_%x", h[:8])
}

// StableIDFromUSB derives a deterministic ID from USB identifiers.
// Priority: serial > device instance ID > location > VID:PID.
// The device instance ID is a Windows-assigned unique identifier for each
// physical device instance, so two identical USB printers without serial
// numbers get distinct identities.
func StableIDFromUSB(vid, pid, serial, location string) string {
	return StableIDFromUSBFull(vid, pid, serial, location, "")
}

// StableIDFromUSBFull is StableIDFromUSB with an explicit device instance ID.
func StableIDFromUSBFull(vid, pid, serial, location, instanceID string) string {
	var key string
	if serial != "" && usableIdentityValue(serial) {
		key = fmt.Sprintf("usb-sn:%s:%s:%s", normalizeIdentityValue(vid), normalizeIdentityValue(pid), normalizeIdentityValue(serial))
	} else if instanceID != "" {
		key = fmt.Sprintf("usb-inst:%s", normalizeIdentityValue(instanceID))
	} else if location != "" {
		key = fmt.Sprintf("usb-loc:%s", normalizeIdentityValue(location))
	} else {
		key = fmt.Sprintf("usb-vidpid:%s:%s", normalizeIdentityValue(vid), normalizeIdentityValue(pid))
	}
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_usb_%x", h[:8])
}

// StableIDFromNetwork derives a deterministic ID from IP and port.
// This is a fallback only when discovery exposes no durable device identity.
func StableIDFromNetwork(ip string, port int) string {
	host := strings.ToLower(normalizeUnicode(strings.TrimSpace(ip)))
	host = strings.Trim(host, "[]")
	if parsed := net.ParseIP(host); parsed != nil {
		host = parsed.String()
	}
	key := fmt.Sprintf("net:%s:%d", host, port)
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_net_%x", h[:8])
}

func StableIDFromEndpoint(endpoint string) string {
	key := fmt.Sprintf("endpoint:%s", strings.ToLower(normalizeUnicode(strings.TrimSpace(endpoint))))
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_ep_%x", h[:8])
}

// StableIDFromIPPURI preserves established default-queue IDs while keeping
// distinct resource paths (including case) separate on multi-queue servers.
func StableIDFromIPPURI(endpoint string, host string, port int) string {
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" {
		return StableIDFromEndpoint(endpoint)
	}
	// A discovered host/port is an observation, not the URI's print
	// authority. Use the actual HTTP(S)/IPP(S) effective port, and use
	// literal URI IPs over stale SNMP address enrichment. Preserve the
	// historical resolved-IP identity for DNS hostnames when one exists.
	switch strings.ToLower(u.Scheme) {
	case "ipp", "ipps":
		port = 631
	case "http":
		port = 80
	case "https":
		port = 443
	default:
		return StableIDFromEndpoint(endpoint)
	}
	if explicit := u.Port(); explicit != "" {
		parsed, parseErr := strconv.Atoi(explicit)
		if parseErr != nil || parsed < 1 || parsed > 65535 {
			return StableIDFromEndpoint(endpoint)
		}
		port = parsed
	}
	if uriIP := net.ParseIP(u.Hostname()); uriIP != nil {
		host = uriIP.String()
	} else if strings.TrimSpace(host) == "" {
		host = u.Hostname()
	}
	// Legacy plaintext IPP /ipp/print shares the TCP 631 scan ID.
	// An IPPS/HTTPS endpoint on that SAME port is a different executable
	// destination. Reusing its plaintext ID could silently replace a secure
	// queue during discovery. Keep established plaintext IDs unchanged;
	// registry alias reconciliation preserves existing secure IDs on upgrade.
	if u.Path == "/ipp/print" && u.RawQuery == "" {
		switch strings.ToLower(u.Scheme) {
		case "ipp", "http":
			return StableIDFromNetwork(host, port)
		case "ipps", "https":
			// Both spellings execute through the same TLS transport.
			u.Scheme = "ipps"
		}
	}
	// A custom IPP resource may be hosted under a virtual HTTP authority.
	// Two URI hostnames can route to different queues even when SNMP reports
	// the same backing IP. Keep the URI host for custom resources; only the
	// historical default /ipp/print retains its legacy host/port ID.
	if u.Path != "/ipp/print" || u.RawQuery != "" {
		host = u.Hostname()
	}
	resource := u.EscapedPath()
	if resource == "" {
		resource = "/"
	}
	// IPP is HTTP and IPPS is HTTPS at the same explicit authority.
	// Discovery can observe the same non-default print resource using either
	// scheme spelling. Keep TLS separate and retain the case-sensitive
	// resource path; only canonicalize the transport spelling.
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "http":
		scheme = "ipp"
	case "https":
		scheme = "ipps"
	}
	// URI authority can arrive as expanded, compressed or bracketed IPv6.
	// These textual forms are the same endpoint, not new printer IDs.
	canonicalHost := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	if ip := net.ParseIP(canonicalHost); ip != nil {
		canonicalHost = ip.String()
	}
	key := "ipp-queue:" + scheme + "://" + net.JoinHostPort(canonicalHost, fmt.Sprint(port)) + resource + "?" + u.RawQuery
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("printer_ep_%x", h[:8])
}

// StableIDForDevice returns a deterministic ID using the strongest available
// physical identity first. Endpoint/name fallbacks remain for devices that do
// not expose a durable identity.
func StableIDForDevice(d DeviceInfo) string {
	if isUnverifiedWSDObservation(d) {
		if key := wsdObservationIdentity(d); key != "" {
			return stableIDFromIdentityKey(key)
		}
		return ""
	}
	if (strings.EqualFold(d.Protocol, "ipp") || strings.EqualFold(d.Protocol, "ipps")) &&
		d.Endpoint != "" && d.NetworkAddress != "" && d.Port > 0 {
		return StableIDFromIPPURI(d.Endpoint, d.NetworkAddress, d.Port)
	}
	if key, ok := physicalIdentityKey(d); ok {
		// Scope new serial-backed USB IDs to VID/PID. Registry reconciliation
		// preserves previously persisted IDs when physical identity matches.
		if strings.HasPrefix(key, "usb-serial:") {
			return StableIDFromUSB(d.USBVID, d.USBPID, d.USBSerial, "")
		}
		return stableIDFromIdentityKey(key)
	}

	if d.SpoolerName != "" {
		return StableIDFromSpooler(d.SpoolerName)
	}
	if d.USBSerial != "" || d.USBVID != "" || strings.EqualFold(d.ConnectionType, "usb") {
		// VID/PID is a model, not a physical USB device. Never manufacture a
		// shared identity for two serial-less printers of the same model.
		// Windows instance and location are device-specific evidence; the
		// native interface path is an exact execution endpoint fallback.
		// WP3 (B3-05): a serial is likewise only an identity when scoped
		// to a usable VID/PID; an unscoped serial must not collapse two
		// units that differ in instance/location/interface evidence.
		serial := strings.TrimSpace(d.USBSerial)
		if usableIdentityValue(serial) &&
			usableIdentityValue(normalizeIdentityValue(d.USBVID)) &&
			usableIdentityValue(normalizeIdentityValue(d.USBPID)) {
			return StableIDFromUSBFull(d.USBVID, d.USBPID, serial, "", "")
		}
		instance := capabilityIdentityValue(d, "device_instance_id")
		location := capabilityIdentityValue(d, "location")
		if instance != "" || location != "" {
			return StableIDFromUSBFull(d.USBVID, d.USBPID, "", location, instance)
		}
		if path := capabilityIdentityValue(d, "device_path"); path != "" {
			return stableIDFromIdentityKey("usb-interface:" + path)
		}
		if endpoint := normalizeIdentityValue(d.Endpoint); usableIdentityValue(endpoint) &&
			(strings.HasPrefix(endpoint, `\\?\usb`) || strings.HasPrefix(endpoint, `\\.\usb`)) {
			return stableIDFromIdentityKey("usb-interface:" + endpoint)
		}
		// No safe identifier. Discovery/registry must not register this as a
		// new physical destination until an operator chooses an interface.
		return ""
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
				} else if strings.HasPrefix(lowerEP, "https://") {
					port = 443
				} else if strings.HasPrefix(lowerEP, "http://") {
					port = 80
				}
				// IPP and IPPS both default to 631. The parse-only rewrite
				// to HTTP(S) above must not change the execution destination
				// represented by this identity.
				if host != "" {
					if strings.HasPrefix(lowerEP, "ipp://") || strings.HasPrefix(lowerEP, "ipps://") || strings.EqualFold(d.Protocol, "ipp") || strings.EqualFold(d.Protocol, "ipps") {
						return StableIDFromIPPURI(d.Endpoint, host, port)
					}
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

	// A display name or model is not an execution identity. Two distinct
	// devices can advertise identical names, especially during incomplete
	// discovery. Leave them unregistered rather than merging their histories.
	return ""
}
