package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const maxPrinterVisibilityBytes = 16 * 1024 * 1024
const maxPrinterVisibilityAliases = 16

// PrinterVisibility is independent local authority, never part of desired state,
// discovered capabilities, pairing or Enabled. Only an absent file defaults to
// the legacy shared behavior; an unreadable or invalid file is an error.
type PrinterVisibility struct {
	Version              int                 `json:"version"`
	DeniedPrinters       map[string]string   `json:"deniedPrinters"`
	DeniedPrinterAliases map[string][]string `json:"deniedPrinterAliases,omitempty"`
	Present              bool                `json:"-"`
}

func PrinterVisibilityPath(configPath string) string {
	return filepath.Join(filepath.Dir(RegistryPath(configPath)), "printer-sharing.json")
}

func validSharingID(id string) bool {
	return id != "" && strings.TrimSpace(id) == id && utf8.ValidString(id) && utf8.RuneCountInString(id) <= 512 &&
		!strings.ContainsFunc(id, unicode.IsControl)
}

func validBindingDigest(digest string) bool {
	if len(digest) != sha256.Size*2 || strings.ToLower(digest) != digest {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

// Parse explicitly rather than unmarshalling a map: duplicate keys (including
// duplicate denied IDs) must not silently erase a local deny.
func decodePrinterVisibility(reader io.Reader) (PrinterVisibility, error) {
	policy := PrinterVisibility{DeniedPrinters: make(map[string]string), DeniedPrinterAliases: make(map[string][]string), Present: true}
	d := json.NewDecoder(reader)
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return policy, fmt.Errorf("sharing policy must be an object")
	}
	seen := make(map[string]bool)
	for d.More() {
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return policy, fmt.Errorf("invalid or duplicate sharing policy field")
		}
		seen[key] = true
		switch key {
		case "version":
			if err := d.Decode(&policy.Version); err != nil {
				return policy, fmt.Errorf("invalid sharing policy version: %w", err)
			}
		case "deniedPrinters":
			start, err := d.Token()
			if err != nil || start != json.Delim('{') {
				return policy, fmt.Errorf("deniedPrinters must be an object")
			}
			for d.More() {
				token, err := d.Token()
				id, ok := token.(string)
				if err != nil || !ok || !validSharingID(id) {
					return policy, fmt.Errorf("invalid sharing printer ID")
				}
				if _, duplicate := policy.DeniedPrinters[id]; duplicate {
					return policy, fmt.Errorf("duplicate sharing printer ID")
				}
				var digest string
				if err := d.Decode(&digest); err != nil || !validBindingDigest(digest) {
					return policy, fmt.Errorf("invalid sharing binding digest")
				}
				policy.DeniedPrinters[id] = digest
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return policy, fmt.Errorf("invalid deniedPrinters object")
			}
		case "deniedPrinterAliases":
			start, err := d.Token()
			if err != nil || start != json.Delim('{') {
				return policy, fmt.Errorf("deniedPrinterAliases must be an object")
			}
			for d.More() {
				token, err := d.Token()
				id, ok := token.(string)
				if err != nil || !ok || !validSharingID(id) {
					return policy, fmt.Errorf("invalid sharing alias anchor")
				}
				if _, duplicate := policy.DeniedPrinterAliases[id]; duplicate {
					return policy, fmt.Errorf("duplicate sharing alias anchor")
				}
				start, err := d.Token()
				if err != nil || start != json.Delim('[') {
					return policy, fmt.Errorf("sharing aliases must be an array")
				}
				aliases := make([]string, 0, 2)
				seenAliases := make(map[string]bool)
				for d.More() {
					var digest string
					if err := d.Decode(&digest); err != nil || !validBindingDigest(digest) || seenAliases[digest] || len(aliases) >= maxPrinterVisibilityAliases {
						return policy, fmt.Errorf("invalid, duplicate or excessive sharing aliases")
					}
					seenAliases[digest] = true
					aliases = append(aliases, digest)
				}
				if end, err := d.Token(); err != nil || end != json.Delim(']') || len(aliases) == 0 {
					return policy, fmt.Errorf("invalid or empty sharing aliases")
				}
				policy.DeniedPrinterAliases[id] = aliases
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return policy, fmt.Errorf("invalid deniedPrinterAliases object")
			}
		default:
			return policy, fmt.Errorf("unknown sharing policy field")
		}
	}
	if end, err := d.Token(); err != nil || end != json.Delim('}') {
		return policy, fmt.Errorf("invalid sharing policy object")
	}
	if _, err := d.Token(); err != io.EOF {
		return policy, fmt.Errorf("trailing sharing policy data")
	}
	if !seen["version"] || !seen["deniedPrinters"] || policy.Version != 1 {
		return policy, fmt.Errorf("unsupported or incomplete sharing policy")
	}
	for id := range policy.DeniedPrinterAliases {
		if _, denied := policy.DeniedPrinters[id]; !denied {
			return policy, fmt.Errorf("sharing alias has no denied stable printer anchor")
		}
	}
	return policy, nil
}

func LoadPrinterVisibility(configPath string) (PrinterVisibility, error) {
	path := PrinterVisibilityPath(configPath)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return PrinterVisibility{Version: 1, DeniedPrinters: make(map[string]string)}, nil
	}
	if err != nil {
		return PrinterVisibility{}, fmt.Errorf("read local sharing policy: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxPrinterVisibilityBytes {
		return PrinterVisibility{}, fmt.Errorf("local sharing policy is not a bounded regular file")
	}
	if err := EnsureSecureDirectoryACL(filepath.Dir(path)); err != nil {
		return PrinterVisibility{}, fmt.Errorf("protect local sharing directory: %w", err)
	}
	if err := EnsureSecureFileACL(path); err != nil {
		return PrinterVisibility{}, fmt.Errorf("protect local sharing policy: %w", err)
	}
	f, err := os.Open(path)
	if err != nil {
		return PrinterVisibility{}, fmt.Errorf("open local sharing policy: %w", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(f, maxPrinterVisibilityBytes+1))
	closeErr := f.Close()
	if readErr != nil {
		return PrinterVisibility{}, fmt.Errorf("read local sharing policy: %w", readErr)
	}
	if closeErr != nil {
		return PrinterVisibility{}, fmt.Errorf("close local sharing policy: %w", closeErr)
	}
	if len(data) > maxPrinterVisibilityBytes {
		return PrinterVisibility{}, fmt.Errorf("local sharing policy exceeds its size limit")
	}
	if !utf8.Valid(data) {
		return PrinterVisibility{}, fmt.Errorf("local sharing policy is not valid UTF-8")
	}
	policy, err := decodePrinterVisibility(strings.NewReader(string(data)))
	if err != nil {
		return PrinterVisibility{}, fmt.Errorf("parse local sharing policy: %w", err)
	}
	return policy, nil
}

func sharingIdentity(value string) string {
	return strings.ToLower(norm.NFC.String(strings.TrimSpace(value)))
}

// PrinterBindingDigest identifies the execution destination, not the display
// label or a hardware serial shared by multiple Windows queues. Byte-language
// changes at one TCP/device endpoint do not bypass a deny. IPP paths remain
// case-sensitive, just as they do in the actual HTTP request.
func PrinterBindingDigest(pc PrinterConfig) (string, error) {
	if err := ValidatePrinterEndpoint(pc); err != nil {
		return "", err
	}
	protocol, err := pc.NormalizedProtocol()
	if err != nil || protocol == "unknown" {
		return "", fmt.Errorf("printer binding has no declared execution protocol")
	}
	var binding string
	switch pc.NormalizedType() {
	case "spooler":
		if protocol != "spooler" {
			return "", fmt.Errorf("invalid spooler binding protocol")
		}
		queue := strings.TrimSpace(pc.SpoolerName)
		if queue == "" {
			queue = strings.TrimSpace(pc.Endpoint)
		}
		if queue == "" || strings.ContainsFunc(queue, unicode.IsControl) {
			return "", fmt.Errorf("missing or invalid native queue binding")
		}
		queue = sharingIdentity(queue)
		// Normalize only unambiguous server spellings, never port/driver/serial
		// identities or spaces in a queue name. Remote queue/share names stay
		// distinct from unrelated local queues.
		if strings.HasPrefix(queue, `\\`) {
			parts := strings.SplitN(strings.TrimPrefix(queue, `\\`), `\`, 2)
			if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
				return "", fmt.Errorf("invalid remote queue binding")
			}
			if parts[0] == "." || parts[0] == "localhost" || parts[0] == "127.0.0.1" {
				host, err := os.Hostname()
				if err != nil || host == "" {
					return "", fmt.Errorf("cannot identify local queue server")
				}
				parts[0] = sharingIdentity(host)
			}
			queue = `\\` + parts[0] + `\` + parts[1]
		}
		binding = "spooler:" + queue
	case "network", "ipp", "ipps":
		if protocol == "ipp" || protocol == "ipps" {
			ep := strings.TrimSpace(pc.Endpoint)
			if !strings.Contains(ep, "://") {
				ep = "http://" + ep + "/ipp/print"
			}
			u, err := url.Parse(ep)
			if err != nil || u.Hostname() == "" {
				return "", fmt.Errorf("invalid IPP binding")
			}
			scheme := strings.ToLower(u.Scheme)
			port := u.Port()
			switch scheme {
			case "ipp":
				scheme = "http"
				if port == "" {
					port = "631"
				}
			case "ipps":
				scheme = "https"
				if port == "" {
					port = "631"
				}
			case "http":
				if port == "" {
					port = "80"
				}
			case "https":
				if port == "" {
					port = "443"
				}
			default:
				return "", fmt.Errorf("invalid IPP binding scheme")
			}
			ip := net.ParseIP(u.Hostname())
			if ip == nil {
				return "", fmt.Errorf("invalid IPP binding host")
			}
			portNumber, err := strconv.Atoi(port)
			if err != nil {
				return "", fmt.Errorf("invalid IPP binding port")
			}
			path := u.EscapedPath()
			if path == "" {
				// Explicit root is its own print resource. Never let one
				// queue's sharing decision apply to another resource.
				path = "/"
			}
			binding = "ipp:" + scheme + "://" + net.JoinHostPort(ip.String(), strconv.Itoa(portNumber)) + canonicalSharingURIPath(path)
		} else {
			if pc.NormalizedType() != "network" || (protocol != "raw" && protocol != "escpos" && protocol != "zpl" && protocol != "tspl") {
				return "", fmt.Errorf("invalid TCP binding protocol")
			}
			host, port, err := net.SplitHostPort(strings.TrimSpace(pc.Endpoint))
			ip := net.ParseIP(host)
			if err != nil || ip == nil {
				return "", fmt.Errorf("invalid TCP binding")
			}
			portNumber, err := strconv.Atoi(port)
			if err != nil {
				return "", fmt.Errorf("invalid TCP binding port")
			}
			binding = "tcp:" + net.JoinHostPort(ip.String(), strconv.Itoa(portNumber))
		}
	case "usb":
		if protocol != "raw" && protocol != "escpos" && protocol != "zpl" && protocol != "tspl" {
			return "", fmt.Errorf("invalid USB binding protocol")
		}
		endpoint := strings.TrimSpace(pc.Endpoint)
		if len(endpoint) <= 4 || (!strings.HasPrefix(endpoint, `\\?\`) && !strings.HasPrefix(endpoint, `\\.\`)) || pc.USBVID == "" || pc.USBPID == "" {
			return "", fmt.Errorf("USB sharing requires its actual unique device path and VID/PID")
		}
		binding = "usb:" + sharingIdentity(endpoint)
	default:
		return "", fmt.Errorf("unknown execution binding")
	}
	digest := sha256.Sum256([]byte(binding))
	return hex.EncodeToString(digest[:]), nil
}

// RFC3986§6.2.2: normalize escape spelling/unreserved octets and dot
// segments, retaining path case, repeated slashes and encoded reserved
// separators. In particular A%2FB is not silently merged with A/B.
func canonicalSharingURIPath(path string) string {
	var normalized strings.Builder
	for i := 0; i < len(path); i++ {
		if path[i] == '%' && i+2 < len(path) {
			value, err := strconv.ParseUint(path[i+1:i+3], 16, 8)
			if err == nil {
				b := byte(value)
				if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || strings.ContainsRune("-._~", rune(b)) {
					normalized.WriteByte(b)
				} else {
					normalized.WriteByte('%')
					normalized.WriteString(strings.ToUpper(path[i+1 : i+3]))
				}
				i += 2
				continue
			}
		}
		normalized.WriteByte(path[i])
	}
	input := normalized.String()
	output := make([]byte, 0, len(input))
	for input != "" {
		switch {
		case strings.HasPrefix(input, "../"):
			input = input[3:]
		case strings.HasPrefix(input, "./"):
			input = input[2:]
		case strings.HasPrefix(input, "/./"):
			input = input[2:]
		case input == "/.":
			input = "/"
		case strings.HasPrefix(input, "/../") || input == "/..":
			if input == "/.." {
				input = "/"
			} else {
				input = input[3:]
			}
			last := len(output) - 1
			for last >= 0 && output[last] != '/' {
				last--
			}
			if last >= 0 {
				output = output[:last]
			} else {
				output = output[:0]
			}
		case input == "." || input == "..":
			input = ""
		default:
			start := 0
			if input[0] == '/' {
				start = 1
			}
			end := strings.Index(input[start:], "/")
			if end < 0 {
				output = append(output, input...)
				input = ""
			} else {
				end += start
				output = append(output, input[:end]...)
				input = input[end:]
			}
		}
	}
	return string(output)
}

// ResolvedPrinterVisibility is an immutable view of one fresh read, never a
// cached GUI permission. Resolving denied bindings once keeps fleet projection
// linear rather than hashing every denied queue for every inventory row.
type ResolvedPrinterVisibility struct {
	policy               PrinterVisibility
	bindings             map[string]struct{}
	discoveryBindings    map[string]struct{}
	knownSpoolerBindings map[string]struct{}
	err                  error
}

func (policy PrinterVisibility) Resolve(known []PrinterConfig) ResolvedPrinterVisibility {
	view := ResolvedPrinterVisibility{policy: policy, bindings: make(map[string]struct{}), discoveryBindings: make(map[string]struct{}), knownSpoolerBindings: make(map[string]struct{})}
	for _, digest := range policy.DeniedPrinters {
		view.bindings[digest] = struct{}{}
		view.discoveryBindings[digest] = struct{}{}
	}
	for _, aliases := range policy.DeniedPrinterAliases {
		for _, digest := range aliases {
			view.bindings[digest] = struct{}{}
			view.discoveryBindings[digest] = struct{}{}
		}
	}
	deniedCurrentIDs := make(map[string]bool)
	for id := range policy.DeniedPrinters {
		deniedCurrentIDs[id] = true
	}
	// A rediscovered ID may have the same exact native queue destination.
	// Attach only its verified descriptor group, never hardware/name guesses.
	for _, current := range known {
		if digest, err := PrinterBindingDigest(current); err == nil {
			if _, denied := view.bindings[digest]; denied {
				deniedCurrentIDs[current.ID] = true
			}
			if current.NormalizedType() == "spooler" && independentlyKnownSpoolerBinding(current) {
				view.knownSpoolerBindings[digest] = struct{}{}
			}
		}
	}
	for _, current := range known {
		if !deniedCurrentIDs[current.ID] {
			continue
		}
		if digest, err := PrinterBindingDigest(current); err == nil {
			view.bindings[digest] = struct{}{}
		} else if view.err == nil {
			view.err = fmt.Errorf("cannot resolve a locally denied printer binding: %w", err)
		}
		if digest, err := discoveryBindingDigest(current); err == nil {
			view.discoveryBindings[digest] = struct{}{}
		}
	}
	return view
}

func (view ResolvedPrinterVisibility) Err() error { return view.err }

// Shared checks ID plus recorded/current denied bindings. A stable denied ID
// that was renamed still denies aliases selecting its current native queue.
func (view ResolvedPrinterVisibility) Shared(pc PrinterConfig) (bool, error) {
	if !view.policy.Present {
		return true, nil
	}
	if _, denied := view.policy.DeniedPrinters[pc.ID]; denied {
		return false, nil
	}
	if view.err != nil {
		return false, view.err
	}
	digest, err := PrinterBindingDigest(pc)
	if err != nil {
		return false, err
	}
	_, denied := view.bindings[digest]
	if denied {
		return false, nil
	}
	// Exact native queue/share evidence cannot prove arbitrary DNS aliases.
	// While local privacy is active, desired state must not authorize a new
	// native destination by itself. Explicit local config/registration or
	// native discovery supplies this independent exact-binding permission.
	//
	// WP3 trap fix: that gate must not privatise a spooler printer that
	// IS locally registered merely because the caller's known list is
	// stale or incomplete (e.g. a runtime-registered printer whose
	// registry persistence lagged, or a heartbeat view built before a
	// discovery sweep persisted). Two independent evidences therefore
	// rescue a printer, and an unrelated deny rescues neither on its own:
	//  (a) its binding is in the caller's known spooler bindings, or
	//  (b) the printer config itself carries an explicit local
	//      registration marker (manual/config/registry; a registry row
	//      that is still setup-only stays excluded).
	// A cloud-only row carries no such marker — desired-state configs are
	// built locally from specific fields only and never inherit a
	// registration_source from the Gateway — so it still stays private
	// while any deny exists. Sharing is never auto-granted by this arm:
	// it only stops an unrelated deny from overriding a local
	// registration; an explicit per-printer deny above still wins, and a
	// printer with no local registration still needs an explicit local
	// share action (which persists it into the known set) to appear.
	if pc.NormalizedType() == "spooler" && len(view.policy.DeniedPrinters) > 0 {
		if _, known := view.knownSpoolerBindings[digest]; known {
			return true, nil
		}
		return locallyRegisteredSpoolerBinding(pc), nil
	}
	return true, nil
}

// locallyRegisteredSpoolerBinding reports whether a printer config itself
// carries explicit local registration evidence, independent of any known
// list the caller passed. Only markers the agent itself writes count:
// manual/config registrations, and durable registry rows that are not
// setup-only candidates. A discovery/config row with no marker, and any
// Gateway desired-state row (which never carries registration_source),
// return false here — their sharing still depends on known-list evidence.
func locallyRegisteredSpoolerBinding(pc PrinterConfig) bool {
	registration, _ := pc.Capabilities["registration_source"].(string)
	switch strings.ToLower(strings.TrimSpace(registration)) {
	case "manual", "config":
		return true
	case "registry":
		verification, _ := pc.Capabilities["verification"].(string)
		switch strings.ToLower(strings.TrimSpace(verification)) {
		case "candidate_only", "device_detected_only":
			return false
		default:
			return true
		}
	default:
		return false
	}
}

func independentlyKnownSpoolerBinding(pc PrinterConfig) bool {
	registration, _ := pc.Capabilities["registration_source"].(string)
	switch strings.ToLower(strings.TrimSpace(registration)) {
	case "manual", "config":
		return true
	case "registry":
		// A durable registry row is local registration evidence, not a
		// cloud claim; only a setup-only candidate row stays excluded.
		verification, _ := pc.Capabilities["verification"].(string)
		switch strings.ToLower(strings.TrimSpace(verification)) {
		case "candidate_only", "device_detected_only":
			return false
		default:
			return true
		}
	}
	verification, _ := pc.Capabilities["verification"].(string)
	switch strings.ToLower(strings.TrimSpace(verification)) {
	case "candidate_only", "device_detected_only":
		return false
	default:
		return true
	}
}

func (policy PrinterVisibility) Shared(pc PrinterConfig, known []PrinterConfig) (bool, error) {
	return policy.Resolve(known).Shared(pc)
}

// DiscoveryShared is a privacy comparison only. A setup candidate's missing
// byte language must not grant execution, but does not hide unrelated scans.
// Its recognizable transport destination still follows an explicit deny.
func (view ResolvedPrinterVisibility) DiscoveryShared(pc PrinterConfig) bool {
	if !view.policy.Present {
		return true
	}
	if _, denied := view.policy.DeniedPrinters[pc.ID]; denied {
		return false
	}
	digest, err := discoveryBindingDigest(pc)
	if err != nil {
		return true
	}
	_, denied := view.discoveryBindings[digest]
	return !denied
}

func (policy PrinterVisibility) DiscoveryShared(pc PrinterConfig, known []PrinterConfig) bool {
	return policy.Resolve(known).DiscoveryShared(pc)
}

func discoveryBindingDigest(pc PrinterConfig) (string, error) {
	if protocol, err := pc.NormalizedProtocol(); err != nil || protocol == "unknown" {
		switch pc.NormalizedType() {
		case "spooler":
			pc.Protocol = "spooler"
		case "ipp":
			pc.Protocol = "ipp"
		case "ipps":
			pc.Protocol = "ipps"
		case "network":
			pc.Protocol = "raw"
			endpoint := strings.ToLower(strings.TrimSpace(pc.Endpoint))
			if strings.HasPrefix(endpoint, "ipp://") || strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
				pc.Protocol = "ipp"
			}
			if strings.HasPrefix(endpoint, "ipps://") {
				pc.Type, pc.ConnectionType, pc.Protocol = "ipps", "ipps", "ipps"
			}
		case "usb":
			pc.Protocol = "raw"
		}
	}
	return PrinterBindingDigest(pc)
}

func SetPrinterVisibility(configPath string, selected PrinterConfig, known []PrinterConfig, shared bool) error {
	if !validSharingID(selected.ID) {
		return fmt.Errorf("invalid local printer ID")
	}
	digest, err := PrinterBindingDigest(selected)
	if err != nil {
		return err
	}
	path := PrinterVisibilityPath(configPath)
	unlock, err := LockLocalFile(path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	policy, err := LoadPrinterVisibility(configPath)
	if err != nil {
		return err
	}
	if shared {
		delete(policy.DeniedPrinters, selected.ID)
		delete(policy.DeniedPrinterAliases, selected.ID)
		for id, deniedDigest := range policy.DeniedPrinters {
			if digest == deniedDigest {
				delete(policy.DeniedPrinters, id)
				delete(policy.DeniedPrinterAliases, id)
			}
		}
		for _, current := range known {
			if _, denied := policy.DeniedPrinters[current.ID]; !denied {
				continue
			}
			currentDigest, err := PrinterBindingDigest(current)
			if err != nil {
				return fmt.Errorf("cannot resolve a locally denied printer binding: %w", err)
			}
			if digest == currentDigest {
				delete(policy.DeniedPrinters, current.ID)
				delete(policy.DeniedPrinterAliases, current.ID)
			}
		}
	} else {
		policy.DeniedPrinters[selected.ID] = digest
		if policy.DeniedPrinterAliases == nil {
			policy.DeniedPrinterAliases = make(map[string][]string)
		}
		aliases := policy.DeniedPrinterAliases[selected.ID]
		seenAliases := make(map[string]bool)
		for _, alias := range aliases {
			seenAliases[alias] = true
		}
		for _, current := range known {
			if current.ID != selected.ID || !current.VerifiedSpoolerSharingAlias {
				continue
			}
			aliasDigest, err := PrinterBindingDigest(current)
			if err != nil {
				return fmt.Errorf("invalid verified native share binding: %w", err)
			}
			if aliasDigest != digest && !seenAliases[aliasDigest] {
				if len(aliases) >= maxPrinterVisibilityAliases {
					return fmt.Errorf("too many verified native sharing aliases")
				}
				aliases = append(aliases, aliasDigest)
				seenAliases[aliasDigest] = true
			}
		}
		if len(aliases) > 0 {
			policy.DeniedPrinterAliases[selected.ID] = aliases
		}
	}
	// Stored aliases remain conservative denials, but never erase another
	// queue's anchor solely through a reused historical Windows share name.
	if shared {
		policy.Present = true
		allowed, err := policy.Resolve(known).Shared(selected)
		if err != nil {
			return err
		}
		if !allowed {
			return fmt.Errorf("selected alias remains denied; select its stable local queue or provide current native binding evidence")
		}
	}
	data, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	if len(data) > maxPrinterVisibilityBytes {
		return fmt.Errorf("local sharing policy exceeds its size limit")
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".printer-sharing-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return err
	}
	if err := EnsureSecureFileACL(temp.Name()); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := replaceFile(temp.Name(), path); err != nil {
		return err
	}
	return EnsureSecureFileACL(path)
}
