package printer

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/yaseir-agent/agent/internal/config"
)

// VirtualCaptureSpoolerName identifies the built-in file capture backend.
// This is not an installed Windows spooler queue or a physical printer.
const VirtualCaptureSpoolerName = "YASEIR_VIRTUAL_TEST_CAPTURE"

const virtualCaptureMaxFiles = 100

// Multiple Agent executors (and even multiple explicitly configured test
// captures) share the same output directory. Serialize quota checking and
// creation so concurrent jobs cannot race past the 100-artifact ceiling.
var virtualCaptureWriteMu sync.Mutex

var safeVirtualJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

// VirtualPrinterTestMode is deliberately OFF unless the service operator
// explicitly enables this diagnostic feature in the Agent environment.
func VirtualPrinterTestMode() bool {
	return os.Getenv("YASEIR_AGENT_VIRTUAL_TEST_MODE") == "1"
}

// IsVirtualCaptureConfig requires a matching transport, explicit virtual
// type, and a deliberate capability flag. Never interpret a real Microsoft
// Print to PDF or FAX spooler queue as this capture backend.
func IsVirtualCaptureConfig(pc config.PrinterConfig) bool {
	if pc.NormalizedType() != "spooler" ||
		!strings.EqualFold(pc.PrinterType, "virtual") ||
		!strings.EqualFold(strings.TrimSpace(pc.SpoolerName), VirtualCaptureSpoolerName) {
		return false
	}
	flag, ok := pc.Capabilities["virtual_test_sink"].(bool)
	return ok && flag
}

// TagConfiguredVirtualCapture annotates ONLY the operator-declared YAML
// sink with its trusted configuration provenance. The Agent heartbeat copies
// these capabilities verbatim, and the Gateway requires this marker before
// admitting a Manager-only virtual test job. Do not modify the input map.
func TagConfiguredVirtualCapture(pc config.PrinterConfig) config.PrinterConfig {
	if !IsVirtualCaptureConfig(pc) {
		return pc
	}
	caps := make(map[string]interface{}, len(pc.Capabilities)+1)
	for key, value := range pc.Capabilities {
		caps[key] = value
	}
	caps["registration_source"] = "config"
	pc.Capabilities = caps
	return pc
}

// IsManagedPrinter preserves the production filter while allowing precisely
// one kind of operator-configured, local file-capture test destination.
func IsManagedPrinter(d DeviceInfo) bool {
	if IsProductionPrinter(d) {
		return true
	}
	if !VirtualPrinterTestMode() || ClassifyDeviceInfo(d).Class != ClassVirtual ||
		!strings.EqualFold(d.PrinterType, "virtual") ||
		!strings.EqualFold(d.SpoolerName, VirtualCaptureSpoolerName) {
		return false
	}
	if d.Capabilities == nil || d.Capabilities["virtual_test_sink"] != true ||
		d.Capabilities["registration_source"] != "config" {
		return false
	}
	return strings.EqualFold(d.ConnectionType, "spooler") &&
		strings.EqualFold(d.Protocol, "spooler")
}

func virtualCaptureOutputDir() (string, error) {
	dir := strings.TrimSpace(os.Getenv("YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR"))
	if dir == "" {
		// Production Windows Services use ProgramData rather than per-user
		// folders (LocalSystem has a different profile than an interactive user).
		base := strings.TrimSpace(os.Getenv("PROGRAMDATA"))
		if base == "" {
			return "", fmt.Errorf("set YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR to an absolute local path")
		}
		dir = filepath.Join(base, "YaseirAgent", "VirtualTestPrints")
	}
	if !filepath.IsAbs(dir) || strings.HasPrefix(dir, `\\`) {
		return "", fmt.Errorf("virtual test output must be an absolute local directory")
	}
	return filepath.Clean(dir), nil
}

type VirtualCapturePrinter struct {
	name string
	dir  string
}

func NewVirtualCapturePrinter(pc config.PrinterConfig) (*VirtualCapturePrinter, error) {
	if !VirtualPrinterTestMode() || !IsVirtualCaptureConfig(pc) {
		return nil, fmt.Errorf("virtual capture requires YASEIR_AGENT_VIRTUAL_TEST_MODE=1 and an explicit virtual_test_sink config")
	}
	dir, err := virtualCaptureOutputDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create virtual test output: %w", err)
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return nil, fmt.Errorf("protect virtual test output directory: %w", err)
	}
	return &VirtualCapturePrinter{name: pc.Name, dir: dir}, nil
}

func (p *VirtualCapturePrinter) Status() string { return "online" }

func (p *VirtualCapturePrinter) StatusDetail() string { return "virtual_file_capture_test_only" }

func (p *VirtualCapturePrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw, KindESCPOS, KindPDF, KindImage, KindZPL, KindTSPL, KindLabel:
		return true
	default:
		return false
	}
}

func (p *VirtualCapturePrinter) Print(ctx context.Context, data []byte) error {
	return p.PrintDocument(ctx, Document{Kind: KindRaw, Data: data})
}

func (p *VirtualCapturePrinter) Test(ctx context.Context) error {
	return p.PrintDocument(ctx, Document{Kind: KindRaw, Data: []byte("Yaseir virtual printer test: no physical paper is produced.\n")})
}

func (p *VirtualCapturePrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	if !p.SupportsKind(kind) {
		return CapabilityMismatchf("virtual test capture cannot handle %s", kind)
	}
	if len(doc.Data) == 0 || len(doc.Data) > maxPrintBytes {
		return fmt.Errorf("virtual test capture size must be 1..%d bytes", maxPrintBytes)
	}
	if kind == KindPDF {
		if err := ValidatePDF(doc.Data); err != nil {
			return fmt.Errorf("virtual capture rejected invalid PDF: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	virtualCaptureWriteMu.Lock()
	defer virtualCaptureWriteMu.Unlock()
	// Bounded local artifacts. Refuse excess jobs rather than silently
	// deleting evidence needed to inspect a failed end-to-end test.
	entries, err := os.ReadDir(p.dir)
	if err != nil {
		return fmt.Errorf("list virtual test captures: %w", err)
	}
	count := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "virtual-") {
			count++
		}
	}
	if count >= virtualCaptureMaxFiles {
		return fmt.Errorf("virtual test capture is full (%d files); archive or remove old test files", virtualCaptureMaxFiles)
	}
	id := doc.JobID
	if !safeVirtualJobID.MatchString(id) {
		id = "local-test"
	}
	extension := kind
	if kind == KindImage {
		extension = "img"
	}
	file, err := os.CreateTemp(p.dir, "virtual-"+id+"-*."+extension)
	if err != nil {
		return fmt.Errorf("create virtual capture: %w", err)
	}
	path := file.Name()
	persisted := false
	defer func() {
		_ = file.Close()
		if !persisted {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(doc.Data); err != nil {
		return fmt.Errorf("write virtual capture: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync virtual capture: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close virtual capture: %w", err)
	}
	if err := config.EnsureSecureFileACL(path); err != nil {
		return fmt.Errorf("protect virtual capture: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	persisted = true
	log.Printf("[virtual-test] captured %s job %q to %s (no paper printed)", kind, doc.JobID, path)
	return nil
}
