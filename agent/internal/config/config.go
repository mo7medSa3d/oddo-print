package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yaseir-agent/agent/internal/storage"
)

const secretStoreKey = "agent_secret"

type Config struct {
	Server struct {
		URL string `yaml:"url"`
	} `yaml:"server"`
	Agent struct {
		ID                string `yaml:"id"`
		Secret            string `yaml:"secret"`
		Name              string `yaml:"name"`
		ReprintAfterCrash *bool  `yaml:"reprint_after_crash,omitempty"`
	} `yaml:"agent"`
	Printers []PrinterConfig `yaml:"printers"`
}

type PrinterConfig struct {
	ID             string                 `yaml:"id"`
	Name           string                 `yaml:"name"`
	Type           string                 `yaml:"type"`
	Endpoint       string                 `yaml:"endpoint"`
	Protocol       string                 `yaml:"protocol"`
	SpoolerName    string                 `yaml:"spooler_name,omitempty"`
	ConnectionType string                 `yaml:"connection_type,omitempty"`
	PrinterType    string                 `yaml:"printer_type,omitempty"`
	USBVID         string                 `yaml:"usb_vid,omitempty"`
	USBPID         string                 `yaml:"usb_pid,omitempty"`
	USBSerial      string                 `yaml:"usb_serial,omitempty"`
	Capabilities   map[string]interface{} `yaml:"capabilities,omitempty"`
	PaperWidthMM   int                    `yaml:"paper_width_mm,omitempty"`
	Enabled        *bool                  `yaml:"enabled,omitempty"`
}

func (c *Config) ReprintAfterCrashEnabled() bool {
	if c == nil || c.Agent.ReprintAfterCrash == nil {
		return false
	}
	return *c.Agent.ReprintAfterCrash
}

// insecureHTTPAllowed reports whether plain HTTP is explicitly opted into.
// Canonical variable is YASEIR_AGENT_ALLOW_INSECURE_HTTP; the legacy
// YASSER_AGENT_ALLOW_INSECURE_HTTP is honored as a fallback so existing
// development environments keep working after the brand migration.
func insecureHTTPAllowed() bool {
	if os.Getenv("YASEIR_AGENT_ALLOW_INSECURE_HTTP") == "1" {
		return true
	}
	return os.Getenv("YASSER_AGENT_ALLOW_INSECURE_HTTP") == "1"
}

func ValidateServerURL(raw string) error {
	u, err := parseServerOrigin(raw)
	if err != nil {
		return err
	}
	// HTTPS is the production/default transport. Plain HTTP is only permitted
	// when explicitly opted into for isolated development or test environments.
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if insecureHTTPAllowed() {
			return nil
		}
		return fmt.Errorf("server.url must use HTTPS; plain HTTP requires YASEIR_AGENT_ALLOW_INSECURE_HTTP=1 for isolated development/test environments")
	default:
		return fmt.Errorf("server.url scheme must be http or https, got %q", u.Scheme)
	}
}

func defaultConfig() *Config {
	cfg := &Config{}
	cfg.Agent.ReprintAfterCrash = boolPtr(false)
	return cfg
}

func boolPtr(v bool) *bool { return &v }

func Load(path string) (*Config, error) {
	if path == "" {
		return defaultConfig(), nil
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve config path: %w", err)
	}
	path = absolutePath

	// Trust the filesystem boundary before reading configuration. Service
	// startup normally calls Ensure first, but pairing/recovery/library callers
	// must not be able to bypass the same owner/DACL/reparse checks by invoking
	// Load directly.
	dir := filepath.Dir(path)
	if _, statErr := os.Stat(dir); statErr == nil {
		if err := EnsureSecureDirectoryACL(dir); err != nil {
			return nil, fmt.Errorf("secure config dir before read %s: %w", dir, err)
		}
	} else if !os.IsNotExist(statErr) {
		return nil, fmt.Errorf("stat config dir %s: %w", dir, statErr)
	}
	if _, statErr := os.Lstat(path); statErr == nil {
		if err := EnsureSecureFileACL(path); err != nil {
			return nil, fmt.Errorf("secure config file before read %s: %w", path, err)
		}
	} else if !os.IsNotExist(statErr) {
		return nil, fmt.Errorf("lstat config %s: %w", path, statErr)
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultConfig(), nil
		}
		return nil, err
	}

	cfg := defaultConfig()
	decodeErr := yaml.NewDecoder(f).Decode(cfg)
	closeErr := f.Close()
	if decodeErr != nil {
		return nil, decodeErr
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close config %s: %w", path, closeErr)
	}
	if cfg.Agent.ReprintAfterCrash == nil {
		cfg.Agent.ReprintAfterCrash = boolPtr(false)
	}

	store := storage.NewStore(dir)
	if sealed, serr := store.GetSecret(secretStoreKey); serr == nil && sealed != "" {
		cfg.Agent.Secret = sealed
		// A previous migration may have sealed the secret but failed to strip
		// the YAML plaintext (Save succeeded, stripped.Save failed). The next
		// Load took this fast path and never retried, leaving the secret in
		// both places forever. Retry the strip best-effort: Load must not fail
		// when the secret is already usable, but the plaintext must not linger.
		if raw, ferr := os.ReadFile(path); ferr == nil && len(raw) > 0 {
			var onDisk Config
			if yerr := yaml.Unmarshal(raw, &onDisk); yerr == nil && onDisk.Agent.Secret != "" {
				stripped := onDisk
				stripped.Agent.Secret = ""
				if serr := stripped.Save(path); serr != nil {
					fmt.Fprintf(os.Stderr, "warning: retry stripping plaintext agent secret: %v\n", serr)
				}
			}
		}
	} else if cfg.Agent.Secret != "" {
		legacySecret := cfg.Agent.Secret
		if merr := store.SaveSecret(secretStoreKey, legacySecret); merr != nil {
			return nil, fmt.Errorf("migrate legacy agent secret to secure storage: %w", merr)
		}
		stripped := *cfg
		stripped.Agent.Secret = ""
		if serr := stripped.Save(path); serr != nil {
			return nil, fmt.Errorf("remove legacy plaintext agent secret from config: %w", serr)
		}
	}
	return cfg, nil
}

func Ensure(path string) error {
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve config path: %w", err)
	}
	path = absolutePath
	dir := filepath.Dir(path)
	if dir == "" {
		dir = "."
	}
	// 0700 from the start: the directory holds pairing secrets and the
	// ACL hardening below only tightens afterwards, so a 0755 transient
	// would leave a world-readable window (every other secrets path in
	// storage/registry/queue already uses 0700 directly).
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}
	if err := EnsureSecureDirectoryACL(dir); err != nil {
		return fmt.Errorf("secure config dir %s: %w", dir, err)
	}
	if _, err := os.Stat(path); err == nil {
		// A pre-existing config file predates ACL hardening (or was restored
		// with loose permissions). Harden it now: Save() hardens on write,
		// but an existing loose file would otherwise stay loose until the
		// next Save.
		if err := EnsureSecureFileACL(path); err != nil {
			return fmt.Errorf("secure config file %s: %w", path, err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat %s: %w", path, err)
	}

	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "yaseir-agent"
	}
	name := "Yaseir Agent"
	if runtime.GOOS == "windows" {
		name = host
	}
	cfg := defaultConfig()
	cfg.Agent.Name = name
	if err := cfg.Save(path); err != nil {
		return fmt.Errorf("create default config %s: %w", path, err)
	}
	return nil
}

func (c *Config) Save(path string) error {
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve config path: %w", err)
	}
	path = absolutePath
	dir := filepath.Dir(path)
	// 0700 from the start (see Ensure above): never a world-readable window
	// for the config/secret directory, even transiently.
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}
	if err := EnsureSecureDirectoryACL(dir); err != nil {
		return fmt.Errorf("secure config dir %s: %w", dir, err)
	}

	toSave := *c
	if c.Agent.Secret != "" {
		if err := storage.NewStore(dir).SaveSecret(secretStoreKey, c.Agent.Secret); err != nil {
			return fmt.Errorf("seal agent secret: %w", err)
		}
		toSave.Agent.Secret = ""
	}

	data, err := yaml.Marshal(&toSave)
	if err != nil {
		return fmt.Errorf("encode config %s: %w", path, err)
	}

	tmpFile, err := os.CreateTemp(filepath.Dir(path), ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp config for %s: %w", path, err)
	}
	tmp := tmpFile.Name()
	// CreateTemp is 0600; re-assert explicitly since this file carries the
	// (sealed) agent secret material alongside the config body.
	if err := tmpFile.Chmod(0600); err != nil {
		tmpFile.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("secure temp config %s: %w", tmp, err)
	}
	f := tmpFile
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write temp config %s: %w", tmp, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("sync temp config %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close temp config %s: %w", tmp, err)
	}
	// Protect the transient file itself before the atomic replace. On Windows,
	// a restrictive parent directory does not rewrite an existing child DACL.
	if err := EnsureSecureFileACL(tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("secure temp config %s: %w", tmp, err)
	}
	if err := replaceFile(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit config %s: %w", tmp, err)
	}
	if err := EnsureSecureFileACL(path); err != nil {
		return fmt.Errorf("secure config file %s: %w", path, err)
	}
	return nil
}

func ExecutableDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

func DefaultConfigPath() string {
	if override := os.Getenv("YASEIR_AGENT_DATA_DIR"); override != "" {
		return filepath.Join(override, "config.yaml")
	}
	// Legacy fallback: pre-migration environments set YASSER_AGENT_DATA_DIR.
	if override := os.Getenv("YASSER_AGENT_DATA_DIR"); override != "" {
		return filepath.Join(override, "config.yaml")
	}
	if override := os.Getenv("ODOO_PRINT_AGENT_DATA_DIR"); override != "" {
		return filepath.Join(override, "config.yaml")
	}
	if pd := os.Getenv("PROGRAMDATA"); pd != "" {
		newPath := filepath.Join(pd, "YaseirAgent", "config.yaml")
		if _, err := os.Stat(newPath); err == nil {
			return newPath
		}
		legacyPath := filepath.Join(pd, "YasserAgent", "config.yaml")
		if _, err := os.Stat(legacyPath); err == nil {
			return legacyPath
		}
		veryLegacyPath := filepath.Join(pd, "OdooPrintAgent", "config.yaml")
		if _, err := os.Stat(veryLegacyPath); err == nil {
			return veryLegacyPath
		}
		return newPath
	}
	dir, err := ExecutableDir()
	if err != nil {
		return "config.yaml"
	}
	return filepath.Join(dir, "config.yaml")
}

func (c *Config) Validate() error {
	if c.Server.URL != "" {
		if err := ValidateServerURL(c.Server.URL); err != nil {
			return err
		}
	}
	if c.Agent.ID != "" && c.Server.URL == "" {
		return fmt.Errorf("agent.id is set but server.url is empty; re-pair or set server.url")
	}
	if c.Agent.ID != "" && c.Agent.Secret == "" {
		return fmt.Errorf("agent.id is set but agent.secret is empty; re-pair the agent")
	}
	for _, p := range c.Printers {
		if err := ValidatePrinterConfig(p); err != nil {
			return err
		}
	}
	return nil
}

var printerIDRe = regexp.MustCompile(`^[a-z0-9_][a-z0-9_-]*$`)

func (p PrinterConfig) NormalizedType() string {
	t := p.ConnectionType
	if t == "" {
		t = p.Type
	}
	t = strings.ToLower(strings.TrimSpace(t))
	switch t {
	case "tcp":
		return "network"
	case "windows_spooler":
		return "spooler"
	case "usb":
		// A USB device with an installed Windows spooler queue is executed by
		// the spooler backend, not by the raw USB backend. Normalize it here so
		// discovery, validation, capability reporting and execution share one
		// transport identity.
		if strings.TrimSpace(p.SpoolerName) != "" {
			return "spooler"
		}
		return "usb"
	case "":
		return "network"
	default:
		return t
	}
}

// NormalizedProtocol returns the EXPLICITLY declared protocol for the
// device. An empty protocol is an error, never a silent default: inventing
// "raw" would turn an unconfigured device into a routable byte sink and
// would skip ESC/POS status preflight (see the strict protocol contract in
// docs/ and src/lib/routing.ts on the gateway side, which mirrors this).
func (p PrinterConfig) NormalizedProtocol() (string, error) {
	proto := strings.ToLower(strings.TrimSpace(p.Protocol))
	if proto == "" {
		switch nt := p.NormalizedType(); nt {
		case "spooler":
			// A spooler queue carries its own transport identity.
			return "spooler", nil
		case "ipp", "ipps":
			return nt, nil
		default:
			return "", fmt.Errorf("printer %s: protocol must be declared explicitly (raw, escpos, zpl, tspl, ipp, ipps, spooler, or unknown)", p.ID)
		}
	}
	if proto == "windows_spooler" {
		return "spooler", nil
	}
	switch proto {
	case "raw", "escpos", "zpl", "tspl", "ipp", "ipps", "spooler", "unknown":
		return proto, nil
	default:
		return "", fmt.Errorf("printer %s: unsupported protocol %q", p.ID, p.Protocol)
	}
}

// NormalizedProtocolOrUnknown is used by REPORTING paths (heartbeat,
// diagnostics) that must never fail the whole agent because ONE printer has
// an undeclared protocol: undeclared reports honestly as "unknown", which
// the gateway capability model refuses to route to.
func (p PrinterConfig) NormalizedProtocolOrUnknown() string {
	proto, err := p.NormalizedProtocol()
	if err != nil {
		return "unknown"
	}
	return proto
}

func (p PrinterConfig) IsEnabled() bool {
	if p.Enabled != nil {
		return *p.Enabled
	}
	return true
}

// IsAllowedPrinterIP applies the destination-address policy shared by configured
// printers and discovery. A permitted address is not evidence of device identity
// or authorization; callers must still validate the endpoint and its owner.
func IsAllowedPrinterIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() {
		return false
	}
	// Cloud metadata services commonly bind to these link-local/ULA addresses;
	// printer destinations must never be usable as a metadata proxy.
	if ip4 := ip.To4(); ip4 != nil && ip4.Equal(net.IPv4(169, 254, 169, 254)) {
		return false
	}
	if strings.EqualFold(ip.String(), "fd00:ec2::254") {
		return false
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func ValidatePrinterConfig(p PrinterConfig) error {
	if p.ID == "" {
		return fmt.Errorf("printer missing id")
	}
	if !printerIDRe.MatchString(p.ID) {
		return fmt.Errorf("printer %q: id must match %s", p.ID, printerIDRe.String())
	}
	if p.Name == "" {
		return fmt.Errorf("printer %s: name required", p.ID)
	}
	nt := p.NormalizedType()
	switch nt {
	case "network", "usb", "spooler", "ipp", "ipps":
	default:
		return fmt.Errorf("printer %s: type must be network/usb/spooler/ipp/ipps, got %q", p.ID, p.Type)
	}
	proto, perr := p.NormalizedProtocol()
	if perr != nil {
		return perr
	}
	// Transport and protocol are one physical contract. Reject combinations
	// that the factory would otherwise interpret differently (for example an
	// IPP transport declared as RAW, which would pass Gateway capability checks
	// but fail only after the Agent starts execution).
	switch nt {
	case "network":
		if proto == "ipps" {
			return fmt.Errorf("printer %s: network connection requires an IPP URL for IPPS; use type ipps", p.ID)
		}
		if proto != "raw" && proto != "escpos" && proto != "zpl" && proto != "tspl" && proto != "ipp" && proto != "unknown" {
			return fmt.Errorf("printer %s: protocol %q is incompatible with network connection", p.ID, proto)
		}
	case "ipp":
		if proto != "ipp" && proto != "unknown" {
			return fmt.Errorf("printer %s: protocol %q is incompatible with ipp connection", p.ID, proto)
		}
	case "ipps":
		if proto != "ipps" && proto != "unknown" {
			return fmt.Errorf("printer %s: protocol %q is incompatible with ipps connection", p.ID, proto)
		}
	case "spooler":
		if proto != "spooler" && proto != "unknown" {
			return fmt.Errorf("printer %s: protocol %q is incompatible with spooler connection", p.ID, proto)
		}
	case "usb":
		if proto == "spooler" {
			return fmt.Errorf("printer %s: usb spooler printers must use type spooler with spooler_name", p.ID)
		}
		if proto != "raw" && proto != "escpos" && proto != "zpl" && proto != "tspl" && proto != "unknown" {
			return fmt.Errorf("printer %s: protocol %q is incompatible with usb connection", p.ID, proto)
		}
	}
	if err := ValidatePrinterEndpoint(p); err != nil {
		return err
	}
	if nt == "usb" {
		// USB entries backed by an explicitly named Windows spooler queue are
		// executed through the spooler backend and therefore do not require raw
		// USB VID/PID identifiers. Direct USB transport still requires both.
		if strings.TrimSpace(p.SpoolerName) == "" {
			if p.USBVID == "" || p.USBPID == "" {
				return fmt.Errorf("printer %s: usb_vid and usb_pid are required for direct USB transport", p.ID)
			}
			ep := strings.TrimSpace(p.Endpoint)
			if !strings.HasPrefix(ep, `\\?\`) && !strings.HasPrefix(ep, `\\.\`) {
				return fmt.Errorf("printer %s: direct USB endpoint must be a Windows device path (\\?\\... or \\.\\...)", p.ID)
			}
		}
	}
	if nt == "spooler" && strings.TrimSpace(p.SpoolerName) == "" {
		return fmt.Errorf("printer %s: spooler_name required", p.ID)
	}
	return nil
}

// ValidatePrinterEndpoint checks network destinations independently of display
// names and inventory IDs. Config validation, discovered inventory and backend
// construction all call this same policy; discovery evidence cannot override
// private/link-local IP, port, credential, query or TLS-scheme restrictions.
// Non-network transports have their own device/queue validation.
func ValidatePrinterEndpoint(p PrinterConfig) error {
	nt := p.NormalizedType()
	if nt != "network" && nt != "ipp" && nt != "ipps" {
		return nil
	}
	proto, err := p.NormalizedProtocol()
	if err != nil {
		return err
	}
	if nt == "network" || nt == "ipp" || nt == "ipps" {
		ep := strings.TrimSpace(p.Endpoint)
		if ep == "" {
			return fmt.Errorf("printer %s: network endpoint required", p.ID)
		}
		if nt == "ipp" || nt == "ipps" || strings.HasPrefix(proto, "ipp") || strings.HasPrefix(strings.ToLower(ep), "ipp://") || strings.HasPrefix(strings.ToLower(ep), "ipps://") || strings.HasPrefix(strings.ToLower(ep), "http://") || strings.HasPrefix(strings.ToLower(ep), "https://") {
			normalizedEndpoint := ep
			if proto == "ipp" && !strings.Contains(ep, "://") {
				if host, port, splitErr := net.SplitHostPort(ep); splitErr == nil && host != "" && port != "" {
					normalizedEndpoint = "http://" + net.JoinHostPort(strings.Trim(host, "[]"), port) + "/ipp/print"
				}
			}
			u, err := url.Parse(normalizedEndpoint)
			if err != nil || u == nil || u.Hostname() == "" {
				// A malformed endpoint may contain userinfo. Do not echo the raw URL
				// in validation errors, which are forwarded to logs and desktop UI.
				return fmt.Errorf("printer %s: invalid IPP endpoint syntax or host", p.ID)
			}
			if u.User != nil {
				return fmt.Errorf("printer %s: IPP endpoint must not contain embedded credentials", p.ID)
			}
			if u.RawQuery != "" || u.Fragment != "" {
				return fmt.Errorf("printer %s: IPP endpoint must not contain query strings or fragments", p.ID)
			}
			scheme := strings.ToLower(u.Scheme)
			if nt == "ipps" && scheme != "https" && scheme != "ipps" {
				return fmt.Errorf("printer %s: IPPS endpoint must use https:// or ipps://", p.ID)
			}
			ip := net.ParseIP(strings.Trim(u.Hostname(), "[]"))
			if ip == nil || !IsAllowedPrinterIP(ip) {
				return fmt.Errorf("printer %s: IPP endpoint host must be a private or link-local IP", p.ID)
			}
			port := 631
			if u.Port() != "" {
				parsed, err := strconv.Atoi(u.Port())
				if err != nil || parsed < 1 || parsed > 65535 {
					return fmt.Errorf("printer %s: invalid IPP endpoint port", p.ID)
				}
				port = parsed
			}
			if port != 80 && port != 443 && port != 631 {
				return fmt.Errorf("printer %s: IPP endpoint port must be 80, 443, or 631", p.ID)
			}
		} else {
			host, port, err := net.SplitHostPort(ep)
			if err != nil {
				return fmt.Errorf("printer %s: network endpoint must be host:port", p.ID)
			}
			ip := net.ParseIP(strings.Trim(host, "[]"))
			if ip == nil || !IsAllowedPrinterIP(ip) {
				return fmt.Errorf("printer %s: network endpoint host must be a private or link-local IP", p.ID)
			}
			parsed, err := strconv.Atoi(port)
			// Gateway-managed network printers use the single canonical RAW TCP
			// destination port 9100. Keeping the Agent boundary identical prevents
			// a printer from being accepted into local config only to be rejected
			// later by heartbeat inventory validation.
			if err != nil || parsed != 9100 {
				return fmt.Errorf("printer %s: network endpoint port must be 9100", p.ID)
			}
		}
	}
	return nil
}
