package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/payload"
	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
)

// Job concurrency limits. Physical printing is serialized per printer, but
// without an upper bound on in-flight jobs a gateway-side burst (e.g. a large
// offline backlog delivered after a reconnect) would spawn one goroutine per
// job and exhaust memory on a small POS terminal.
//
// maxConcurrentJobs — jobs actually executing (HTTP status calls, printing)
// maxPendingJobs    — jobs accepted into the local executor, including ones
//
//	waiting for an execution slot; overflows are dropped
//	and naturally re-delivered by the gateway after the
//	claim lease expires (see src/app/api/agent/jobs).
const (
	maxConcurrentJobs        = 8
	maxPendingJobs           = 64
	maxPendingJobsPerPrinter = 8
	// WebSocket/read-loop side work is bounded. The gateway's claim lease
	// remains the final recovery mechanism if these best-effort queues fill.
	maxRejectQueue = 32
	maxWSAckQueue  = 64
)

// Gateway response bounds. Every control-plane response read is capped so a
// hostile or buggy server cannot make the agent allocate without limit:
//   - error/diagnostic bodies are only logged, so 8 KiB keeps both the
//     allocation and the log line bounded;
//   - the job poll carries at most maxClaimBatch jobs, each bounded by
//     payload.MaxPayloadBytes (the same ceiling dispatch enforces), so the
//     product is the documented batch ceiling — a larger response is a
//     contract violation and is rejected instead of absorbed;
//   - the heartbeat carries the first bounded manager-owned desired-state
//     page. Legacy gateways can return a larger complete snapshot; the
//     collector still enforces the local metadata budget before applying it.
const (
	maxGatewayErrorBodyBytes = 8 << 10
	maxClaimBatch            = 20
	// Heartbeat is control-plane metadata only. Keep a hard multi-megabyte
	// ceiling for legacy responses. Current Gateway pages are much smaller;
	// a bounded cap prevents a malformed gateway from consuming hundreds of MiB.
	maxHeartbeatBytes            = 32 << 20
	maxHeartbeatProbeConcurrency = 64
)

func maxPollJobsBytes() int64 {
	return int64(maxClaimBatch) * int64(payload.MaxPayloadBytes)
}

// pollJobsByteLimit is the live poll-response ceiling: the decoded-bytes
// batch product above (20 x 5 MiB = 100 MiB). The gateway additionally
// trims every poll response to MAX_POLL_RESPONSE_BYTES = 64 MiB of ENCODED
// wire bytes (src/app/api/agent/jobs/route.ts), so this reader always has
// headroom: twenty maximum-size jobs would frame at ~140 MiB encoded and
// fail the whole batch decode while their claims stayed delivery-pending.
// It defaults to the documented batch product and is only varied by tests
// in this package (which run sequentially), so a bounded read can be
// exercised without transferring the full production ceiling.
var pollJobsByteLimit = maxPollJobsBytes()

// shutdownGrace bounds how long Run waits for in-flight jobs after the agent
// is asked to stop. The Windows SCM default stop timeout is 30s.
const shutdownGrace = 25 * time.Second

// Bounds for Gateway-lifecycle-driven backoff. A disabled/retired agent or
// a dead credential must not hammer the Gateway on the 5s poll cadence:
// 5 minutes keeps presence heartbeats informative while capping pointless
// traffic. Any other rejected heartbeat backs off one minute. Both are
// cleared by the next fully successful heartbeat, so re-enable (or a key
// fix) recovers without operator action on the box and without restart.
const lifecycleFenceBackoff = 5 * time.Minute
const localTerminalJobRetentionHours = 48
const localQueueCleanupInterval = time.Hour
const lifecycleProbeBackoff = 60 * time.Second

// While the WebSocket is connected the poll loop still runs every
// wsSafetyPollEvery ticks (5s tick => every 30s) so claimed-but-undelivered
// jobs are reclaimed after the gateway's 90s claim lease instead of being
// stuck until the socket drops.
const wsSafetyPollEvery = 6

// printDocumentTimeout bounds a single physical print as a function of the
// payload size. Base 2m covers dial + spooler setup + a small receipt; each
// megabyte adds 30s, which is generous even for a 9600-baud thermal
// (~1.2KB/s). This is a HARD cap against a permanently stuck device — the
// transport applies tighter per-write stall detection — and it is sized so a
// legitimate 5MB job (~4m) completes well inside the window.
func printDocumentTimeout(payloadBytes int) time.Duration {
	const base = 2 * time.Minute
	const perMB = 30 * time.Second
	mb := int64(payloadBytes) / (1024 * 1024)
	if mb < 0 {
		mb = 0
	}
	return base + time.Duration(mb)*perMB
}

const printerLockShards = 128

type rejectWork struct {
	ctx        context.Context
	jobID      string
	claimToken string
	reason     string
	key        string
}

type wsAckWork struct {
	ctx     context.Context
	conn    *websocket.Conn
	payload []byte
	jobID   string
}

type Agent struct {
	cfg          *config.Config
	configPath   string
	registryPath string
	client       *http.Client
	// printersMu protects printers and printerConfigs: the async discovery
	// goroutine and Discover/RegisterManual mutate them while heartbeat
	// payloads and job dispatch read them concurrently.
	printersMu     sync.RWMutex
	printers       map[string]printer.Printer
	printerConfigs map[string]config.PrinterConfig
	// registryOwned is the runtime subset sourced only from a complete,
	// successfully read printers.json snapshot. YAML-owned IDs are excluded.
	registryOwned map[string]struct{}
	queue         *queue.Queue
	// A bounded shard set avoids an unbounded mutex map. Collisions only
	// serialize unrelated printer IDs; correctness is unchanged.
	jobLocks [printerLockShards]sync.Mutex

	// Job executor: bounded, deduplicated, and tracked for clean shutdown.
	execSem      chan struct{}       // limits concurrently executing jobs
	pendingSlots chan struct{}       // limits accepted (executing + waiting) jobs
	inFlight     map[string]struct{} // job ids currently in the executor
	// inFlightTokens carries the claim token of each in-flight delivery
	// attempt, under the same mutex. Heartbeat keep-alives echo the token
	// so the gateway can fence the lease refresh to the live claim.
	inFlightTokens map[string]string
	// pendingByPrinter bounds waiting goroutines for a single printer so one
	// slow/unreachable device cannot consume the entire global pending budget.
	pendingByPrinter map[string]int
	inFlightPrinters map[string]string
	// inFlightReceived records when each delivery was accepted, under the
	// same mutex. It bounds the physical-dispatch race: the gateway sweep
	// can only reclaim a claim observed stale for a full lease window, so
	// a transport failure inside that window cannot be masking a
	// reassignment (see authorizeDispatchAfterReportFailure).
	inFlightReceived map[string]time.Time
	// terminalExecution fences a physical result in memory when the printer
	// side effect completed but SQLite could not persist the terminal row.
	// This is intentionally process-local: after restart the durable row is
	// still `printing` and MarkInterrupted converts it to an explicit unknown
	// outcome, preventing silent re-execution. While the process remains up,
	// duplicate deliveries must never re-enter the printer after this window.
	terminalExecution map[string]terminalExecutionResult
	inFlightMu        sync.Mutex
	wg                sync.WaitGroup

	// Guards making heartbeat/poll ticks non-reentrant. A slow tick (offline
	// printers probing at 2s, slow gateway) must never let ticks pile up.
	hbMu   sync.Mutex
	pollMu sync.Mutex
	// terminalReportMu prevents concurrent terminal-status reporting goroutines.
	terminalReportMu sync.Mutex
	// Execution fence driven by Gateway lifecycle responses. When the
	// Gateway reports this agent disabled/retired (heartbeat 409), the
	// agent must stop accepting new work instead of heartbeating and
	// polling indefinitely: no new local dispatch is admitted and job
	// acquisition polls are skipped, while in-flight executions finish
	// normally (killing them mid-print is worse) and heartbeats continue
	// so re-enable recovers without operator action on the box. A later
	// successful heartbeat clears the fence. execFenceBackoffUntil bounds
	// poll retries after 401/409/5xx so a dead credential or a disabled
	// agent does not hammer the Gateway.
	execFence             atomic.Bool
	execFenceReason       atomic.Value // string
	execFenceBackoffUntil atomic.Int64 // unix nanos; poll ticks before this are skipped

	// discoverySem bounds concurrent gateway-directed discovery sessions to
	// one: each session is a full bounded LAN scan (30s bound), and piling
	// them up per pending session (as an unbounded go-per-session did)
	// would fork a scan per session. Pending sessions expire on the
	// gateway in 60s, so the next poll tick simply picks the rest up.
	discoverySem chan struct{}

	// shutdownCh is closed exactly once when Run begins stopping; dispatchJob
	// refuses new work afterwards so the queue is never closed while jobs are
	// still being scheduled.
	shutdownCh  chan struct{}
	shutdownOne sync.Once
	closeOne    sync.Once
	// shutdownGate serializes shutdown with dispatch registration.
	shutdownGate sync.RWMutex
	// runtimeWG tracks background goroutines owned by Run until shutdown drains them.
	runtimeWG sync.WaitGroup

	// rejectQueue is the bounded hand-back path used by the WS reader when
	// local admission is saturated. The reader never performs the HTTP PATCH
	// itself. Each work item carries the connection/session context so a closed
	// WebSocket cancels stale rejection work before it can mutate Gateway state.
	rejectQueue   chan rejectWork
	rejectMu      sync.Mutex
	rejectPending map[string]struct{}

	wsMu   sync.RWMutex
	wsConn *websocket.Conn
	// wsWriteMu serializes writes on the WebSocket: gorilla/websocket allows
	// at most one concurrent writer, and job acknowledgements are written from
	// the read loop while pings/other frames may be written elsewhere.
	wsWriteMu sync.Mutex

	// Single-flight probe state per printer: prevents unbounded goroutine accumulation
	// when Win32 Spooler or network RPC calls block.
	probeStateMu sync.Mutex
	probeStates  map[string]*printerProbeState

	// Gateway desired-state cache. Desired configuration is manager-owned;
	// runtime status/capabilities remain agent-owned observations.
	desiredStateMu        sync.Mutex
	desiredStates         map[string]desiredPrinterRecord
	gatewayOwned          map[string]struct{}
	gatewayTombstones     map[string]struct{}
	desiredStatePath      string
	desiredStateSynced    bool
	desiredStatePersistMu sync.Mutex
}

type terminalExecutionResult struct {
	status       string
	errMsg       string
	claimToken   string
	spoolerJobID string
}

type printerProbeState struct {
	running      atomic.Bool
	lastStatusMu sync.Mutex
	lastStatus   string
}

func (p *printerProbeState) get() string {
	p.lastStatusMu.Lock()
	defer p.lastStatusMu.Unlock()
	return p.lastStatus
}

func (p *printerProbeState) set(status string) {
	p.lastStatusMu.Lock()
	defer p.lastStatusMu.Unlock()
	p.lastStatus = status
}

func (a *Agent) probeLastStatus(printerID string) string {
	return a.getProbeState(printerID).get()
}

func (a *Agent) setProbeLastStatus(printerID, status string) {
	a.getProbeState(printerID).set(status)
}

func (a *Agent) getProbeState(printerID string) *printerProbeState {
	a.probeStateMu.Lock()
	defer a.probeStateMu.Unlock()
	if a.probeStates == nil {
		a.probeStates = make(map[string]*printerProbeState)
	}
	st, exists := a.probeStates[printerID]
	if !exists {
		st = &printerProbeState{lastStatus: "unknown"}
		a.probeStates[printerID] = st
	}
	return st
}

func (a *Agent) deleteProbeState(printerID string) {
	a.printersMu.RLock()
	_, stillPresent := a.printerConfigs[printerID]
	a.printersMu.RUnlock()
	if stillPresent {
		return
	}
	a.probeStateMu.Lock()
	if st, ok := a.probeStates[printerID]; ok && !st.running.Load() {
		delete(a.probeStates, printerID)
	}
	a.probeStateMu.Unlock()
}

// observeDesiredRevision advances the physical-observation fence only after
// a real backend status probe returns a usable device state. Instantiating a
// backend from configuration is not proof that the device is reachable.
func (a *Agent) observeDesiredRevision(printerID, status string) {
	a.desiredStateMu.Lock()
	defer a.desiredStateMu.Unlock()
	row, ok := a.desiredStates[printerID]
	if !ok || row.Desired.Lifecycle != "active" || row.ApplyError != "" {
		return
	}
	usable := status == "online" || status == "busy"
	if status == "unknown" && row.Desired.ConnectionType == "network" {
		switch strings.ToLower(strings.TrimSpace(row.Desired.Protocol)) {
		case "raw", "escpos", "zpl", "tspl":
			// Status() reached the device but has no readable back-channel. This
			// proves connectivity/config observation without claiming health.
			usable = true
		}
	}
	if !usable {
		return
	}
	if row.AppliedDesiredRevision >= row.Desired.DesiredRevision &&
		row.ObservedDesiredRevision < row.Desired.DesiredRevision {
		row.ObservedDesiredRevision = row.AppliedDesiredRevision
		a.desiredStates[printerID] = row
	}
}

func (a *Agent) legacyPrinterDisabled(id string) bool {
	if a.cfg == nil {
		return false
	}
	for _, pc := range a.cfg.Printers {
		if pc.ID == id && !pc.IsEnabled() {
			return true
		}
	}
	return false
}

// Printer map accessors. The printer map is mutated by the async discovery
// goroutine started in New and by Discover/RegisterManual, while heartbeat
// status payloads and job dispatch read it concurrently — all access must go
// through these helpers.
// priorSessionMayBeLive reports whether replacing the given backend could
// overlap a still-running transport session. The dispatch path holds the
// per-printer lock across synchronous hardware I/O, so the only live case
// at replacement time is a detached session that outlived its caller's
// return (wedged Win32 worker, abandoned kernel write). Backends without
// live-session reporting never block replacement.
func priorSessionMayBeLive(old printer.Printer) bool {
	if old == nil {
		return false
	}
	if r, ok := old.(printer.LiveSessionReporter); ok {
		return r.SessionMayBeLive()
	}
	return false
}

func (a *Agent) addPrinter(id string, p printer.Printer, pc config.PrinterConfig) bool {
	if !pc.IsEnabled() || a.legacyPrinterDisabled(id) {
		return false
	}
	lock := a.getPrinterLock(id)
	lock.Lock()
	defer lock.Unlock()
	a.printersMu.Lock()
	defer a.printersMu.Unlock()
	if _, gatewayManaged := a.gatewayOwned[id]; gatewayManaged {
		return false
	}
	if old, exists := a.printerConfigs[id]; exists {
		// Rediscovery re-reports every known device on each sweep. An
		// identical config is a no-op (no churn, no log spam). A CHANGED
		// config (endpoint moved, protocol or credentials rotated - DHCP
		// reassignment is the classic case) must replace both the backend
		// and the stored facts atomically: otherwise dispatch, capability
		// gating, and heartbeats keep using the stale device indefinitely
		// (until process restart), sending jobs to a dead address or
		// gating against the wrong protocol. In-flight work already holds
		// its resolved backend object, so replacement cannot corrupt an
		// executing print.
		if reflect.DeepEqual(old, pc) {
			return false
		}
		if priorSessionMayBeLive(a.printers[id]) {
			// A prior session (wedged Win32 worker, abandoned kernel
			// write) may still own the physical transport. The replacement
			// carries a fresh mutex/latch, so swapping now would permit
			// overlapping submissions to the same device. Defer: the next
			// discovery sweep retries once the session drains.
			log.Printf("printer %q backend replacement deferred: a prior print session may still own the transport; retrying on a later sweep", id)
			return false
		}
		log.Printf("printer %q re-registered with changed configuration; refreshing runtime backend and facts", id)
	}
	a.printers[id] = p
	a.printerConfigs[id] = pc
	return true
}

func (a *Agent) getPrinter(id string) (printer.Printer, bool) {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	p, ok := a.printers[id]
	return p, ok
}

// resolvePrinterAlias maps a Gateway-issued cross-agent alias back to the
// local backend. Aliases have the form "<local stable ID>~<8 hex chars>";
// locally generated stable IDs never contain "~", so stripping the suffix
// recovers the local device. An exact local match always wins: resolution
// only fires when the alias itself names no local backend.
func (a *Agent) resolvePrinterAlias(printerID string) string {
	if _, ok := a.getPrinter(printerID); ok {
		return printerID
	}
	if i := strings.LastIndexByte(printerID, '~'); i > 0 && len(printerID)-i-1 == 8 {
		suffix := printerID[i+1:]
		valid := true
		for j := 0; j < len(suffix); j++ {
			c := suffix[j]
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				valid = false
				break
			}
		}
		if valid {
			if _, ok := a.getPrinter(printerID[:i]); ok {
				return printerID[:i]
			}
		}
	}
	return printerID
}

func (a *Agent) printerCount() int {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	return len(a.printers)
}

func printerConfigFromDeviceInfo(di printer.DeviceInfo) config.PrinterConfig {
	// Single authority mapping a discovered/manual DeviceInfo onto the
	// backend PrinterConfig. Every field the USB backend needs (VID/PID/
	// serial) and everything the heartbeat reports (capabilities, class)
	// must survive this translation; dropping fields here silently
	// degrades direct-USB printers to VID 0/PID 0.
	return config.PrinterConfig{
		ID:           di.ID,
		Name:         di.Name,
		Type:         di.ConnectionType,
		Endpoint:     di.Endpoint,
		Protocol:     di.Protocol,
		SpoolerName:  di.SpoolerName,
		PrinterType:  di.PrinterType,
		USBVID:       di.USBVID,
		USBPID:       di.USBPID,
		USBSerial:    di.USBSerial,
		Capabilities: di.Capabilities,
	}
}

func (a *Agent) mergeDiscoveredPrinter(di printer.DeviceInfo) (bool, error) {
	pc := printerConfigFromDeviceInfo(di)
	p, err := printer.New(pc)
	if err != nil {
		return false, err
	}
	return a.addPrinter(di.ID, p, pc), nil
}

// New builds the agent and initializes every configured printer backend.
// A printer that fails to initialize (bad config, unsupported type) is
// logged and skipped rather than aborting the whole agent - other
// printers on the same agent must keep working.
// It also loads the persistent discovery registry (printers.json) and merges
// discovered/manual printers idempotently, so repeated discovery does not
// create duplicates and the production config does not depend on printers: [].
func New(cfg *config.Config, configPath string) (*Agent, error) {
	dbPath := config.QueueDBPath(configPath)
	q, err := queue.New(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open local queue at %s: %w", dbPath, err)
	}

	registryPath := config.RegistryPath(configPath)

	a := &Agent{
		cfg:          cfg,
		configPath:   configPath,
		registryPath: registryPath,
		// Never follow redirects with the credential-bearing client: a 3xx
		// from the gateway/proxy would otherwise forward
		// `Authorization: Bearer id:secret` to the redirect target.
		// Callers treat 3xx as an error and surface it.
		client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		printers:          make(map[string]printer.Printer),
		printerConfigs:    make(map[string]config.PrinterConfig),
		registryOwned:     make(map[string]struct{}),
		queue:             q,
		execSem:           make(chan struct{}, maxConcurrentJobs),
		pendingSlots:      make(chan struct{}, maxPendingJobs),
		inFlight:          make(map[string]struct{}),
		inFlightTokens:    make(map[string]string),
		pendingByPrinter:  make(map[string]int),
		inFlightPrinters:  make(map[string]string),
		inFlightReceived:  make(map[string]time.Time),
		terminalExecution: make(map[string]terminalExecutionResult),
		shutdownCh:        make(chan struct{}),
		discoverySem:      make(chan struct{}, 1),
		rejectQueue:       make(chan rejectWork, maxRejectQueue),
		rejectPending:     make(map[string]struct{}),
		desiredStates:     make(map[string]desiredPrinterRecord),
		gatewayOwned:      make(map[string]struct{}),
		desiredStatePath:  desiredStatePath(configPath),
	}

	if err := a.loadDesiredState(); err != nil {
		log.Printf("WARNING: failed to recover Gateway desired state: %v", err)
	}

	// 1. Load configured printers from YAML (legacy, still supported for backward compat)
	for _, pc := range cfg.Printers {
		if !pc.IsEnabled() {
			continue
		}
		p, err := printer.New(pc)
		if err != nil {
			log.Printf("WARNING: printer %q (%s) not initialized: %v", pc.ID, pc.Name, err)
			continue
		}
		a.addPrinter(pc.ID, p, pc)
	}

	// 2. Merge registry printers (discovered + manually registered) — idempotent.
	// Phase14: Do quick local discovery synchronously (config+spooler+registry) to avoid
	// blocking startup on 8s LAN scan. Full network/USB discovery runs asynchronously.
	quick := printer.DiscoverQuick(cfg, registryPath)
	quick.Printers = printer.RuntimeDiscoveryPrinters(quick.Printers)
	quick.Printers = a.filterGatewayOwned(quick.Printers)
	if len(quick.Errors) > 0 {
		for _, e := range quick.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}
	if len(quick.Printers) > 0 {
		merged, persistErr := a.persistDiscoveredPrinters(quick.Printers)
		if persistErr == nil {
			a.reconcileRegistryPrinters(merged)
		} else {
			for _, di := range merged {
				if _, err := a.mergeDiscoveredPrinter(di); err != nil {
					log.Printf("WARNING: discovered printer %q not initialized: %v", di.ID, err)
				}
			}
		}
	}

	if a.printerCount() == 0 {
		log.Printf("INFO: no printers configured yet; run discovery or add manually. Jobs will be queued until a printer is available.")
	} else {
		log.Printf("Agent initialized with %d printer(s) (config + registry)", a.printerCount())
	}

	return a, nil
}

// A persistence failure must not discard successfully observed hardware.
// The inventory capability carries the failure until a later successful scan.
func (a *Agent) persistDiscoveredPrinters(infos []printer.DeviceInfo) ([]printer.DeviceInfo, error) {
	merged, err := printer.UpsertRegistry(a.registryPath, infos)
	if err == nil {
		// UpsertRegistry merges the current observations with historical rows.
		// Re-apply the runtime-capability filter so an old candidate-only LPR
		// row cannot re-enter the production inventory after a newer scan.
		return printer.RuntimeDiscoveryPrinters(merged), nil
	}
	log.Printf("WARNING: failed to persist discovery registry; retaining %d runtime observations: %v", len(infos), err)
	return markRegistryPersistenceError(infos, err), err
}

// persistLiveDiscovery reconciles a live discovery pass with printers.json.
// Unlike persistDiscoveredPrinters, this path may retire a stale automatic
// Windows spooler row, but only when the same scan proved the spooler source
// authoritative. USB/network non-response and partial source failures remain
// additive and can never delete durable inventory.
func (a *Agent) persistLiveDiscovery(result printer.DiscoveryResult) ([]printer.DeviceInfo, error) {
	infos := printer.RuntimeDiscoveryPrinters(result.Printers)
	infos = a.filterGatewayOwned(infos)
	merged, err := printer.ReconcileDiscoveryRegistry(a.registryPath, infos, result.CompleteSources)
	if err == nil {
		return printer.RuntimeDiscoveryPrinters(merged), nil
	}
	log.Printf("WARNING: failed to reconcile live discovery registry; retaining %d runtime observations: %v", len(infos), err)
	return markRegistryPersistenceError(infos, err), err
}

func markRegistryPersistenceError(infos []printer.DeviceInfo, err error) []printer.DeviceInfo {
	for index := range infos {
		caps := make(map[string]interface{}, len(infos[index].Capabilities)+1)
		for key, value := range infos[index].Capabilities {
			caps[key] = value
		}
		caps["registry_persistence_error"] = boundedDiscoveryText(err.Error(), 2048)
		infos[index].Capabilities = caps
	}
	return infos
}

// ListPrinters returns the current discovered/configured printer inventory.
func (a *Agent) ListPrinters() []printer.DeviceInfo {
	infos, err := printer.ListPrinters(a.cfg, a.registryPath)
	if err != nil {
		log.Printf("[printer] failed to list printers: %v", err)
		return nil
	}
	return printer.RuntimeDiscoveryPrinters(infos)
}

// Discover runs discovery and refreshes the local registry + printer map.
func (a *Agent) Discover() printer.DiscoveryResult {
	result := printer.DiscoverLive(a.cfg, a.registryPath)
	merged, persistErr := a.persistLiveDiscovery(result)
	if persistErr != nil {
		result.Errors = append(result.Errors, "registry persistence: "+persistErr.Error())
	} else {
		// Reconcile the complete durable registry, not just the live observations:
		// manual/config rows remain executable while an absent auto spooler queue
		// is removed from the runtime map under the per-printer execution lock.
		a.reconcileRegistryPrinters(merged)
	}
	result.Printers = merged

	log.Printf("Discovery completed: %d printers found", len(result.Printers))
	return result
}

func (a *Agent) runInitialAsyncDiscovery(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[discovery] async full discovery panic: %v", r)
		}
	}()

	// Small delay to let gateway communication start first
	select {
	case <-ctx.Done():
		return
	case <-time.After(2 * time.Second):
	}

	select {
	case <-ctx.Done():
		return
	default:
	}

	// Share the same one-scan semaphore used by manager-triggered discovery.
	// If a manager scan already owns it, startup discovery is opportunistic and
	// can safely defer to the next explicit/periodic discovery request.
	select {
	case a.discoverySem <- struct{}{}:
	case <-ctx.Done():
		return
	default:
		log.Printf("[discovery] async full discovery deferred: another discovery is already running")
		return
	}
	releaseSemaphore := true
	defer func() {
		if releaseSemaphore {
			<-a.discoverySem
		}
	}()

	log.Printf("[discovery] starting bounded async full discovery (network+USB)")
	full, completed, finishedCh := runBoundedDiscovery(ctx, defaultDiscoveryTimeout, func(scanCtx context.Context) printer.DiscoveryResult {
		return printer.DiscoverLiveWithContext(scanCtx, a.cfg, a.registryPath)
	})
	if !completed {
		// A synchronous Win32 call can outlive its Go context. Keep the semaphore
		// owned until that worker actually returns, but do not attach this waiter
		// to runtimeWG: graceful shutdown must not wait forever on OS RPC.
		releaseSemaphore = false
		a.releaseDiscoverySemaphoreWhenFinished(finishedCh)
		log.Printf("[discovery] async full discovery exceeded %s bound; worker may still be finishing", defaultDiscoveryTimeout)
		return
	}
	if len(full.Errors) > 0 {
		for _, e := range full.Errors {
			log.Printf("discovery warning: %s", e)
		}
	}

	select {
	case <-ctx.Done():
		return
	default:
	}

	merged, persistErr := a.persistLiveDiscovery(full)
	if persistErr != nil {
		full.Errors = append(full.Errors, "registry persistence: "+persistErr.Error())
	} else {
		a.reconcileRegistryPrinters(merged)
	}

	log.Printf("[discovery] async discovery completed: %d live observations, %d durable runtime printers", len(full.Printers), len(merged))
}

// RegisterManual adds a manually configured printer (for when discovery cannot identify correctly).
func (a *Agent) isGatewayOwned(id string) bool {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	if _, ok := a.gatewayOwned[id]; ok {
		return true
	}
	_, tombstoned := a.gatewayTombstones[id]
	return tombstoned
}

func (a *Agent) filterGatewayOwned(infos []printer.DeviceInfo) []printer.DeviceInfo {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	out := make([]printer.DeviceInfo, 0, len(infos))
	for _, info := range infos {
		if _, ok := a.gatewayOwned[info.ID]; ok {
			continue
		}
		if _, tombstoned := a.gatewayTombstones[info.ID]; tombstoned {
			continue
		}
		out = append(out, info)
	}
	return out
}

func (a *Agent) RegisterManual(info printer.DeviceInfo) error {
	if info.ID != "" {
		if a.isGatewayOwned(info.ID) {
			return fmt.Errorf("printer ID %q is managed by the Gateway", info.ID)
		}
		if _, exists := a.getPrinter(info.ID); exists {
			return fmt.Errorf("printer ID %q already exists", info.ID)
		}
	}
	if info.ID == "" {
		info.ID = printer.StableIDForDevice(info)
	}
	if _, err := printer.RegisterManual(a.registryPath, info); err != nil {
		return err
	}
	pc := printerConfigFromDeviceInfo(info)
	p, err := printer.New(pc)
	if err != nil {
		return err
	}
	if !a.addPrinter(info.ID, p, pc) {
		return fmt.Errorf("printer ID %q already exists", info.ID)
	}
	log.Printf("Manual printer registered: %s (%s)", info.ID, info.Name)
	return nil
}

// TestPrinter runs a real test print against the given printer ID.
func (a *Agent) TestPrinter(printerID string) error {
	return printer.TestPrinter(a.cfg, a.registryPath, printerID)
}

// Close releases the durable local queue once accepted job handlers have
// drained. Windows printer drivers can block synchronously beyond context
// cancellation, so shutdown must never close SQLite underneath a still-live
// physical-print goroutine. If work remains, leave the queue open for process
// teardown; the next Agent start recovers durable `printing` rows as an
// explicitly unknown physical outcome.
//
// The queue field is deliberately NOT nil-ed. Once inFlight reaches zero, no
// accepted handler can still perform queue I/O; wg.Wait only closes the tiny
// defer window between removing the in-flight marker and the goroutine's final
// Done. The shutdown gate must already be closed before Close is called.
func (a *Agent) Close() error {
	if remaining := a.inFlightCount(); remaining > 0 {
		log.Printf("WARNING: leaving local queue open during shutdown because %d accepted job handler(s) are still in flight", remaining)
		return nil
	}
	a.wg.Wait()
	var cerr error
	a.closeOne.Do(func() {
		if a.queue != nil {
			cerr = a.queue.Close()
		}
	})
	return cerr
}

// beginShutdown atomically closes the job-acceptance gate. Safe to call more
// than once (e.g. service stop after an interactive Ctrl+C).
func (a *Agent) beginShutdown() {
	a.shutdownGate.Lock()
	defer a.shutdownGate.Unlock()
	a.shutdownOne.Do(func() { close(a.shutdownCh) })
}

// noteHeartbeatRejection processes a rejected heartbeat response (HTTP >=
// 300) for lifecycle management. It never touches printer hardware and never
// changes what the Gateway believes: it only arms local gates.
//
//   - 401: the credential is dead (revoked/rotated). Re-pair semantics are
//     unchanged (doAuthorizedRequest already logs the re-pair directive);
//     additionally fence new dispatch and back off job-acquisition polls so a dead credential does
//     not hammer the Gateway on the 5s cadence. Heartbeats continue at 30s
//     as presence.
//   - 409: the Gateway refused this agent's lifecycle (disabled/retired).
//     Enter the execution fence: no new local dispatch is admitted and
//     acquisition polls are skipped until a later heartbeat succeeds.
//     In-flight executions are deliberately NOT disturbed — killing them
//     mid-print is worse than letting owned claims finish.
//   - anything else: short probe backoff, no fence (fail open on unknown
//     rejections; a disabled agent is always reported as 409 today).
func (a *Agent) noteHeartbeatRejection(statusCode int, body []byte) {
	now := time.Now()
	switch {
	case statusCode == http.StatusUnauthorized:
		a.execFenceReason.Store("gateway heartbeat 401: credential rejected; re-pair the Agent")
		a.execFence.Store(true)
		a.execFenceBackoffUntil.Store(now.Add(lifecycleFenceBackoff).UnixNano())
		log.Printf("Heartbeat rejected (401): credential rejected; new dispatch fenced and polls backed off for %v", lifecycleFenceBackoff)
	case statusCode == http.StatusConflict:
		reason := fmt.Sprintf("gateway heartbeat 409: %s", firstLineOfBody(body))
		a.execFence.Store(true)
		a.execFenceReason.Store(reason)
		a.execFenceBackoffUntil.Store(now.Add(lifecycleFenceBackoff).UnixNano())
		log.Printf("Agent execution fenced (%s); new dispatch refused and polls skipped until a heartbeat succeeds", reason)
	default:
		a.execFenceBackoffUntil.Store(now.Add(lifecycleProbeBackoff).UnixNano())
	}
}

// clearLifecycleFence releases the execution fence and any poll backoff
// after a fully successful heartbeat cycle. Called only on success, so a
// re-enabled (or re-keyed) agent resumes autonomously.
func (a *Agent) clearLifecycleFence() {
	if a.execFence.Load() {
		log.Printf("Agent execution fence cleared by successful heartbeat")
	}
	a.execFence.Store(false)
	a.execFenceReason.Store("")
	a.execFenceBackoffUntil.Store(0)
}

// fencedForDispatch reports whether new local dispatch must be refused.
// Lock-free: safe on the hot dispatch path under -race.
func (a *Agent) fencedForDispatch() bool {
	return a.execFence.Load()
}

// fenceReason returns the recorded fence cause for logs. Empty when clear.
func (a *Agent) fenceReason() string {
	if v := a.execFenceReason.Load(); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// lifecycleBackoffActive reports whether job-acquisition polls must be
// skipped right now (bounded post-rejection backoff).
func (a *Agent) lifecycleBackoffActive() bool {
	return time.Now().UnixNano() < a.execFenceBackoffUntil.Load()
}

// firstLineOfBody renders a bounded snippet of a rejection body for logs.
// Bodies are Gateway-controlled diagnostics, never credentials.
func firstLineOfBody(body []byte) string {
	const maxLen = 160
	s := strings.TrimSpace(string(body))
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		s = s[:idx]
	}
	s = strings.ReplaceAll(s, "\r", " ")
	if len(s) > maxLen {
		s = s[:maxLen] + "…"
	}
	if s == "" {
		s = "empty body"
	}
	return s
}

func (a *Agent) launchTracked(fn func()) {
	a.runtimeWG.Add(1)
	go func() {
		defer a.runtimeWG.Done()
		fn()
	}()
}

func (a *Agent) Run(ctx context.Context) error {
	if a.cfg.Agent.ID == "" {
		log.Println("CRITICAL: Agent not registered. Staying alive so the desktop manager can pair it.")
		<-ctx.Done()
		return nil
	}

	log.Printf("Agent %s starting (ID: %s, %d printer(s) configured)", a.cfg.Agent.Name, a.cfg.Agent.ID, a.printerCount())

	// Crash recovery must run before any new delivery is accepted.
	a.recoverInterruptedJobs(ctx)
	a.reportPendingTerminalStatuses(ctx)
	a.cleanupRetainedLocalJobs()

	a.launchTracked(func() { a.connectWebSocket(ctx) })
	a.launchTracked(func() { a.runRejectWorker(ctx) })
	a.launchTracked(func() { a.runInitialAsyncDiscovery(ctx) })

	heartbeatTicker := time.NewTicker(30 * time.Second)
	// Poll fallback: reduced from 10s to 5s per 2025 best practice.
	// WebSocket is primary (10-50ms latency per docs), poll is safety net.
	// Short polling latency = interval/2 avg, so 5s => 2.5s avg delay when WS down,
	// vs 10s => 5s avg before. Halves perceived delay for job delivery fallback.
	pollTicker := time.NewTicker(5 * time.Second)
	// Discovery poll: reduced from 30s to 10s. Manager-triggered discovery
	// sessions now start within 10s max instead of 30s, matching user expectation
	// of <10s for discovery. Full scan itself is bounded 30s.
	discoveryTicker := time.NewTicker(10 * time.Second)
	cleanupTicker := time.NewTicker(localQueueCleanupInterval)
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()
	defer discoveryTicker.Stop()
	defer cleanupTicker.Stop()

	// Send an immediate heartbeat/poll on startup instead of waiting a full tick.
	a.launchTracked(func() { a.sendHeartbeatGuardedContext(ctx) })
	a.launchTracked(func() { a.pollJobsGuarded(ctx) })
	a.launchTracked(func() { a.pollDiscovery(ctx) })

	// Counts poll ticks skipped because the WebSocket is connected.
	wsSafetyPollTicks := 0

	for {
		select {
		case <-ctx.Done():
			log.Println("Agent stopping...")
			a.beginShutdown()
			if c := a.getWSConn(); c != nil {
				if err := c.Close(); err != nil {
					log.Printf("WebSocket shutdown close failed: %v", err)
				}
			}
			a.runtimeWG.Wait()
			if !a.waitForJobs() {
				// Some Windows print APIs (GDI/driver RPC) are synchronous and can
				// remain blocked past context cancellation. Do not close their live
				// handles from another goroutine and do not hold the SCM stop path
				// forever. Return after the bounded grace; Agent.Close deliberately
				// leaves SQLite open while an accepted handler is still in flight.
				// Process teardown then owns final OS-handle cleanup, and the next
				// start recovers any durable `printing` row as physically unknown.
				log.Printf("WARNING: shutdown grace elapsed with jobs still in flight; returning without closing the local queue so process teardown can contain blocked OS printing calls safely.")
			}
			return nil
		case <-heartbeatTicker.C:
			// Never block the select loop: heartbeat probes TCP-reachability
			// of every configured printer, which can take seconds when offline.
			// Heartbeats are presence: they continue even while fenced so a
			// re-enabled agent is detected promptly (a success clears the
			// fence); only job acquisition below is gated.
			a.launchTracked(func() { a.sendHeartbeatGuardedContext(ctx) })
		case <-pollTicker.C:
			a.launchTracked(func() { a.reportPendingTerminalStatuses(ctx) })
			// Fenced (disabled/retired) or backing off (dead credential,
			// recent rejection): do not acquire new work. Terminal-outcome
			// replay above still runs — the Gateway must learn completed
			// work even from a fenced agent.
			if a.fencedForDispatch() || a.lifecycleBackoffActive() {
				break
			}
			// Poll is the primary delivery path while the WebSocket is down.
			// While the socket IS up it still runs as a safety net every
			// wsSafetyPollEvery ticks: a job that was claimed for WS delivery
			// but never reached the agent (socket died between claim and
			// send, agent restarted, backlog overflow) is only recovered by
			// the poll endpoint's stale-claim reclaim. Without this the job
			// would sit claimed until the agent happened to disconnect.
			if a.getWSConn() == nil {
				wsSafetyPollTicks = 0
				a.launchTracked(func() { a.pollJobsGuarded(ctx) })
			} else {
				wsSafetyPollTicks++
				if wsSafetyPollTicks >= wsSafetyPollEvery {
					wsSafetyPollTicks = 0
					a.launchTracked(func() { a.pollJobsGuarded(ctx) })
				}
			}
		case <-discoveryTicker.C:
			a.launchTracked(func() { a.pollDiscovery(ctx) })
		case <-cleanupTicker.C:
			a.launchTracked(func() { a.cleanupRetainedLocalJobs() })
		}
	}
}

func (a *Agent) cleanupRetainedLocalJobs() {
	deleted, err := a.queue.CleanupTerminalOlderThan(localTerminalJobRetentionHours)
	if err != nil {
		log.Printf("Background queue retention cleanup failed: %v", err)
		return
	}
	if deleted > 0 {
		log.Printf("Background queue retention cleanup deleted %d terminal jobs older than %d hours", deleted, localTerminalJobRetentionHours)
	}
}

// reportPendingTerminalStatuses replays durable local terminal outcomes until
// the Gateway acknowledges one with a 2xx response. This is an Agent-local
// transactional outbox: it closes the crash window between the SQLite terminal
// write and the remote status report without ever re-running printer I/O.
func (a *Agent) reportPendingTerminalStatuses(ctx context.Context) {
	if !a.terminalReportMu.TryLock() {
		return
	}
	defer a.terminalReportMu.Unlock()

	reports, err := a.queue.PendingTerminalReports(32)
	if err != nil {
		log.Printf("Terminal status outbox scan failed: %v", err)
		return
	}
	for _, report := range reports {
		if ctx.Err() != nil {
			return
		}
		if err := a.updateJobStatus(ctx, report.ID, report.Status, report.LastError, report.ClaimToken, report.SpoolerJobID); err != nil {
			log.Printf("Job %s: pending terminal status report failed: %v", report.ID, err)
		}
	}
}

// recoverInterruptedJobs handles jobs that were still physically printing when
// the previous agent process stopped.
//
// Their outcome is genuinely unknown (the printer may have printed everything,
// part of the document, or nothing), so the agent does NOT guess. The local
// row is marked terminal with queue.InterruptedMarker in both cases; what
// differs is what is told to the gateway, per agent.reprint_after_crash:
//
//   - true:  explicitly ask the gateway to requeue the current printing claim
//     with the exact claim token. The gateway records an ambiguous prior
//     attempt, increments the retry budget, and returns the job to queued. The
//     next delivery is therefore a distinct, fenced physical attempt. This is
//     deliberate at-least-once behavior and may duplicate paper.
//   - false: report the job failed with an explicit reason so the gateway
//     stops immediately and the document is never silently reprinted.
//
// Either way this is NOT exactly-once printing; the physical outcome of the
// interrupted attempt is unknown and that is what gets recorded.
func (a *Agent) recoverInterruptedJobs(ctx context.Context) {
	interrupted, err := a.queue.MarkInterrupted()
	if err != nil {
		log.Printf("WARNING: could not scan the local queue for interrupted jobs: %v", err)
	}
	reprint := a.cfg.ReprintAfterCrashEnabled()
	for _, job := range interrupted {
		if reprint {
			log.Printf(
				"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). reprint_after_crash=true: requesting an explicit fenced Gateway requeue for a new at-least-once attempt.",
				job.ID, job.PrinterID,
			)
			if job.ClaimToken == "" {
				log.Printf("Job %s: cannot request crash requeue without the preserved claim token; leaving the local unknown outcome terminal", job.ID)
				continue
			}
			if err := a.updateJobStatus(ctx, job.ID, "queued", "AGENT_RESTART_DURING_PRINT: operator-enabled at-least-once crash recovery", job.ClaimToken, job.SpoolerJobID, "agent_reprint_after_crash"); err != nil {
				log.Printf("Job %s: Gateway rejected crash-requeue request; lease/recovery remains authoritative: %v", job.ID, err)
				continue
			}
			// The Gateway has now durably accepted the new queued state. The local
			// terminal row remains only as physical-ambiguity evidence until the
			// next delivery; clear its old execution token so it cannot be mistaken
			// for the next attempt's fence.
			if err := a.queue.ClearClaimToken(job.ID, job.ClaimToken); err != nil {
				log.Printf("Job %s: failed to clear old claim token after crash requeue: %v", job.ID, err)
			}
			continue
		}
		log.Printf(
			"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). Reporting it as failed; reprint_after_crash=%v",
			job.ID, job.PrinterID, reprint,
		)
		a.updateJobStatus(ctx, job.ID, "failed", queue.InterruptedMarker+
			": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)", job.ClaimToken, job.SpoolerJobID)
	}
	if len(interrupted) > 0 {
		log.Printf("Crash recovery: %d job(s) were interrupted mid-print (reprint_after_crash=%v)", len(interrupted), reprint)
	}
}

func (a *Agent) getWSConn() *websocket.Conn {
	a.wsMu.RLock()
	defer a.wsMu.RUnlock()
	return a.wsConn
}

func (a *Agent) setWSConn(c *websocket.Conn) {
	a.wsMu.Lock()
	a.wsConn = c
	a.wsMu.Unlock()
}

func (a *Agent) connectWebSocket(ctx context.Context) {
	wsURL, err := config.GatewayWebSocketURL(a.cfg.Server.URL)
	if err != nil {
		log.Printf("Invalid server URL: %v", err)
		return
	}

	var retry wsReconnectBackoff
	var retryDelay time.Duration

	for {
		if retryDelay > 0 && !waitForWSReconnect(ctx, retryDelay) {
			return
		}
		select {
		case <-ctx.Done():
			return
		default:
			log.Printf("Connecting to WebSocket: %s", wsURL)
			header := http.Header{}
			header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))

			c, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, header)
			if err != nil {
				retryDelay = retry.nextDelay(0)
				log.Printf("WebSocket dial failed: %v. Retrying in %s...", err, retryDelay.Round(time.Millisecond))
				continue
			}

			sessionStarted := time.Now()
			a.setWSConn(c)
			log.Println("WebSocket connected.")

			sessionCtx, sessionCancel := context.WithCancel(ctx)
			sessionDone := make(chan struct{})
			sessionAckQueue := make(chan wsAckWork, maxWSAckQueue)

			// Context cancellation must actively wake ReadMessage. This watcher
			// is tracked by runtimeWG and is session-scoped, so it cannot leave
			// an orphaned reader behind during shutdown or test-controlled close.
			a.launchTracked(func() {
				select {
				case <-sessionCtx.Done():
					if err := c.Close(); err != nil {
						log.Printf("WebSocket session cancellation close failed: %v", err)
					}
				case <-sessionDone:
				}
			})
			a.launchTracked(func() {
				a.runWSAckWorker(sessionCtx, sessionAckQueue)
			})

			err = a.handleWSMessages(ctx, sessionCtx, sessionAckQueue)
			close(sessionDone)
			sessionCancel()
			a.setWSConn(nil)
			if closeErr := c.Close(); closeErr != nil {
				log.Printf("WebSocket connection close cleanup failed: %v", closeErr)
			}
			retryDelay = retry.nextDelay(time.Since(sessionStarted))
			if err != nil {
				log.Printf("WebSocket connection lost: %v. Retrying in %s...", err, retryDelay.Round(time.Millisecond))
			}
		}
	}
}

// wsIdleTimeout must exceed the server's 30s ping interval with margin. No
// frame for longer than this means the socket is half-open (NAT/LB idle drop
// is routine on POS connections) and the read loop must fail so the poll
// fallback takes over — otherwise job delivery silently degrades forever.
const wsIdleTimeout = 90 * time.Second

// maxWSFrameBytes bounds one inbound frame: the gateway's own message cap is
// 64KB for agent->server traffic, while server->agent job envelopes carry a
// base64 payload of up to ~5 MiB. Anything larger is hostile or corrupt.
const maxWSFrameBytes = 8 << 20

func (a *Agent) handleWSMessages(ctx context.Context, sessionCtx context.Context, ackQueue chan<- wsAckWork) error {
	conn := a.getWSConn()
	if conn == nil {
		return fmt.Errorf("connection closed")
	}
	conn.SetReadLimit(maxWSFrameBytes)
	if err := conn.SetReadDeadline(time.Now().Add(wsIdleTimeout)); err != nil {
		return fmt.Errorf("set initial WebSocket read deadline: %w", err)
	}
	conn.SetPingHandler(func(data string) error {
		if err := conn.SetReadDeadline(time.Now().Add(wsIdleTimeout)); err != nil {
			return fmt.Errorf("refresh WebSocket read deadline on ping: %w", err)
		}
		// WriteControl has its own internal control-frame mutex and may
		// interleave with wsWriteMu-serialized data writes, as documented.
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsIdleTimeout))
	})
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if conn == nil {
			return fmt.Errorf("connection closed")
		}
		_, message, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		// Data frames prove the peer is alive as much as pings do. A busy
		// socket carrying jobs but no pings for >90s must not trip the idle
		// timeout and drop a healthy connection.
		if err := conn.SetReadDeadline(time.Now().Add(wsIdleTimeout)); err != nil {
			return fmt.Errorf("refresh WebSocket read deadline on message: %w", err)
		}

		var envelope map[string]interface{}
		if err := json.Unmarshal(message, &envelope); err != nil {
			log.Printf("Malformed WS message: %v", err)
			continue
		}

		typ, err := readStringField(envelope, "type", false, false)
		if err != nil {
			log.Printf("Malformed WS message: %v", err)
			continue
		}

		// Handle discovery trigger (instant push, 10-50ms) — manager started a discovery session
		if typ == "discovery" {
			discoveryID, err := readStringField(envelope, "discoveryId", true, false)
			if err != nil {
				log.Printf("Malformed discovery WS message: %v", err)
				continue
			}
			log.Printf("[discovery] received instant WS trigger for session %s", discoveryID)
			// Trigger discovery immediately, don't wait for 10s poll
			select {
			case a.discoverySem <- struct{}{}:
				a.launchTracked(func() {
					session := a.loadDiscoverySession(ctx, discoveryID)
					if session == nil {
						<-a.discoverySem
						return
					}
					a.executeDiscoverySession(ctx, discoveryID, session)
				})
			default:
				log.Printf("[discovery] session %s deferred: a discovery session is already running", discoveryID)

			}
			continue
		}

		job, err := extractJobFromWSMessage(envelope)
		if err != nil {
			log.Printf("Malformed WS job message: %v", err)
			continue
		}
		if job == nil {
			log.Printf("Ignoring WS message without a print job: %v", typ)
			continue
		}

		fields, err := decodeJobFields(job)
		if err != nil {
			log.Printf("Malformed WS job message: %v", err)
			continue
		}
		jobID := fields.ID
		// Validate the delivery is addressed to THIS agent and is a live
		// claim. A replayed or mis-routed frame (gateway restart, backlog
		// re-push, stale instance) must never print.
		if fields.AgentID != "" && fields.AgentID != a.cfg.Agent.ID {
			log.Printf("Job %s: WS delivery addressed to a different agent; ignoring", jobID)
			continue
		}
		if fields.Status != "" && fields.Status != "claimed" {
			log.Printf("Job %s: WS delivery carries non-claimed status %q; ignoring", jobID, fields.Status)
			continue
		}

		// ACK is an admission acknowledgement, not a transport receipt. The
		// Agent sends it only after dispatchJob successfully reserves a local
		// executor slot. Rejected/saturated/duplicate deliveries are not ACKed;
		// this prevents the Gateway from mistaking a pre-execution rejection for
		// a locally accepted job.
		if a.dispatchJobWithContexts(ctx, sessionCtx, job) {
			if err := a.enqueueJobAck(sessionCtx, ackQueue, jobID, fields.ClaimToken); err != nil {
				log.Printf("Job %s: failed to queue job_ack after local admission: %v", jobID, err)
			}
		}
	}
}

// extractJobFromWSMessage understands both the current delivery envelope
//
// {"type":"print_job","job":{...}}
//
// and the legacy bare-job message ({"id":...,"printerId":...}) so an agent
// still works against an older gateway build.
func extractJobFromWSMessage(msg map[string]interface{}) (map[string]interface{}, error) {
	if msg == nil {
		return nil, nil
	}
	t, err := readStringField(msg, "type", false, false)
	if err != nil {
		return nil, err
	}
	switch t {
	case "print_job":
		if rawJob, exists := msg["job"]; exists {
			if job, ok := rawJob.(map[string]interface{}); ok {
				return job, nil
			}
			return nil, fmt.Errorf("field %q has invalid type %T; expected JSON object", "job", rawJob)
		}
		// Envelope with flat aliases only.
		if _, exists := msg["id"]; exists {
			if _, err := readStringField(msg, "id", true, false); err != nil {
				return nil, err
			}
			return msg, nil
		}
		return nil, nil
	case "":
		if _, exists := msg["id"]; exists {
			if _, err := readStringField(msg, "id", true, false); err != nil {
				return nil, err
			}
			return msg, nil
		}
		return nil, nil
	default:
		return nil, nil
	}
}

// jobWireFields is the strict subset of the Gateway job contract that the
// Agent reads directly. Payload decoding remains owned by payload.Parse, while
// these runtime decision fields must never silently collapse to zero values.
type jobWireFields struct {
	ID         string
	AgentID    string
	PrinterID  string
	Status     string
	RequestID  string
	ClaimToken string
}

func readStringField(m map[string]interface{}, field string, required, nullable bool) (string, error) {
	if m == nil {
		return "", fmt.Errorf("field %q cannot be read from a nil object", field)
	}
	raw, exists := m[field]
	if !exists {
		if required {
			return "", fmt.Errorf("field %q is missing", field)
		}
		return "", nil
	}
	if raw == nil {
		if nullable {
			return "", nil
		}
		return "", fmt.Errorf("field %q has invalid type null; expected string", field)
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("field %q has invalid type %T; expected string", field, raw)
	}
	if required && value == "" {
		return "", fmt.Errorf("field %q is empty", field)
	}
	return value, nil
}

func decodeJobFields(job map[string]interface{}) (jobWireFields, error) {
	id, err := readStringField(job, "id", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	printerID, err := readStringField(job, "printerId", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	agentID, err := readStringField(job, "agentId", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	status, err := readStringField(job, "status", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	if status != "claimed" {
		return jobWireFields{}, fmt.Errorf("field %q has invalid state %q; expected claimed", "status", status)
	}
	requestID, err := readStringField(job, "requestId", false, true)
	if err != nil {
		return jobWireFields{}, err
	}
	claimToken, err := readStringField(job, "claimToken", true, false)
	if err != nil {
		return jobWireFields{}, err
	}
	return jobWireFields{
		ID:         id,
		AgentID:    agentID,
		PrinterID:  printerID,
		Status:     status,
		RequestID:  requestID,
		ClaimToken: claimToken,
	}, nil
}

// enqueueJobAck serializes ACK writes away from the WebSocket reader.
// The queue is bounded: once full, the Agent deliberately drops the
// best-effort ACK and relies on the fenced "printing" status report / poll
// fallback for delivery evidence. ACK order remains FIFO within a connection
// because runWSAckWorker is the sole data writer for that session.
func (a *Agent) enqueueJobAck(ctx context.Context, queue chan<- wsAckWork, jobID, claimToken string) error {
	if queue == nil {
		return fmt.Errorf("websocket ACK queue is unavailable")
	}
	conn := a.getWSConn()
	if conn == nil {
		return fmt.Errorf("no websocket connection")
	}
	ack := map[string]string{"type": "job_ack", "jobId": jobID}
	if claimToken != "" {
		ack["claimToken"] = claimToken
	}
	payload, err := json.Marshal(ack)
	if err != nil {
		return err
	}
	work := wsAckWork{ctx: ctx, conn: conn, payload: payload, jobID: jobID}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case queue <- work:
		return nil
	default:
		return fmt.Errorf("websocket ACK queue full (%d)", maxWSAckQueue)
	}
}

func (a *Agent) runWSAckWorker(ctx context.Context, queue <-chan wsAckWork) {
	for {
		select {
		case <-ctx.Done():
			return
		case work := <-queue:
			if work.ctx.Err() != nil {
				continue
			}
			a.wsWriteMu.Lock()
			if work.ctx.Err() == nil && work.conn == a.getWSConn() && work.conn != nil {
				if err := work.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
					log.Printf("Job %s: failed to set ACK write deadline: %v", work.jobID, err)
				} else if err := work.conn.WriteMessage(websocket.TextMessage, work.payload); err != nil {
					log.Printf("Job %s: failed to write job_ack: %v", work.jobID, err)
				}
			}
			a.wsWriteMu.Unlock()
		}
	}
}

// classifyPanicOutcome decides the terminal report for a panic during job
// execution. A panic is phase-ambiguous: it may strike before admission,
// after BeginPrint, or after bytes reached the device. The only safe rule is:
//
//   - ledger unreadable or row in `printing`: UNKNOWN (bytes may be sent);
//   - row already `success`: success stands (never reopened);
//   - row already failed with an unknown-outcome marker: UNKNOWN is preserved
//     so the Gateway cannot misclassify the job as provably not printed and
//     auto-retry onto possibly existing paper;
//   - otherwise (queued, plain failed, missing row): plain failed.
//
// Pure function of its inputs so the matrix stays pinned by unit tests.
func classifyPanicOutcome(readErr error, found bool, localStatus string, priorUnknown bool, r interface{}) (status, msg string) {
	panicMsg := fmt.Sprintf("AGENT_PANIC: %v", r)
	if readErr != nil || (found && localStatus == "printing") {
		return "failed", "UNKNOWN_PARTIAL_DELIVERY: " + panicMsg + " (physical outcome cannot be proven absent after agent panic)"
	}
	if found && localStatus == "success" {
		return "success", ""
	}
	if priorUnknown {
		return "failed", "UNKNOWN_PARTIAL_DELIVERY: " + panicMsg + " (prior attempt outcome unknown; physical outcome cannot be proven absent after agent panic)"
	}
	return "failed", panicMsg
}

// dispatchJob schedules exactly one job for execution under three safety
// rules:
//
//  1. Dedupe: a job id already being executed/waiting is dropped (the gateway
//     can legitimately deliver the same job over WS and the poll fallback).
//  2. Bounded backlog: at most maxPendingJobs are in flight; beyond that the
//     job is dropped and the gateway re-delivers after the claim lease.
//  3. Bounded execution: at most maxConcurrentJobs execute at once; per-
//     printer serialization still happens inside processJob.
//
// It never blocks the caller (WS read loop / poll loop) for more than
// bookkeeping, so WebSocket ping/pong handling is never starved.
func (a *Agent) dispatchJob(ctx context.Context, job map[string]interface{}) bool {
	return a.dispatchJobWithContexts(ctx, ctx, job)
}

// dispatchJobWithContexts separates the Agent execution lifecycle from the
// WebSocket session lifecycle. Once a job is admitted locally, its execution
// must survive a WS reconnect; only Agent shutdown cancels physical execution.
// Rejection/ACK side effects remain tied to the originating WS session.
func (a *Agent) dispatchJobWithContexts(executionCtx, sessionCtx context.Context, job map[string]interface{}) bool {
	fields, err := decodeJobFields(job)
	if err != nil {
		log.Printf("Received malformed job; rejecting execution: %v", err)
		return false
	}
	jobID := fields.ID
	pendingPrinter := a.resolvePrinterAlias(fields.PrinterID)

	// The shutdown check, dedupe insert, and WaitGroup Add must be atomic with
	// respect to each other: Run begins its Wait only after the shutdownCh is
	// closed, so any Add that passes the gate is guaranteed to happen before
	// that Wait — a late Add can never race with a Wait observing a zero
	// counter (sync.WaitGroup's forbidden interleaving).
	a.shutdownGate.RLock()
	a.inFlightMu.Lock()
	select {
	case <-a.shutdownCh:
		a.inFlightMu.Unlock()
		a.shutdownGate.RUnlock()
		// The agent is stopping. Report a FENCED pre-execution rejection so
		// the gateway can re-queue the job without burning attempts. If the
		// PATCH fails (network down), the undelivered-claim sweep remains
		// the safe backstop: it only re-queues claims that never showed
		// delivery evidence.
		a.enqueueReject(sessionCtx, jobID, fields.ClaimToken, "agent_shutting_down")
		return false
	default:
	}
	if a.fencedForDispatch() {
		a.inFlightMu.Unlock()
		a.shutdownGate.RUnlock()
		// The Gateway fenced this agent (disabled/retired): it must not
		// execute, but the claim arrived anyway (WS push racing the fence).
		// Hand it back pre-execution with the existing shutdown reason —
		// the contract accepts only the five pre-execution reasons and this
		// one carries identical semantics (proven no bytes, delivery
		// attempt refunded, retries loop-bounded). The Gateway event will
		// name agent_shutting_down; the agent log names the real fence.
		log.Printf("Job %s refused: agent execution-fenced (%s); handing back pre-execution", jobID, a.fenceReason())
		a.enqueueReject(sessionCtx, jobID, fields.ClaimToken, "agent_shutting_down")
		return false
	}
	if terminal, done := a.terminalExecution[jobID]; done {
		// A prior physical attempt completed, but terminal SQLite persistence
		// failed. Refuse every further physical dispatch in this process.
		// Re-reporting is safe because the claim token remains fenced; a stale
		// reclaimed claim simply rejects the report and recovery can reconcile
		// the durable Gateway state later.
		a.inFlightMu.Unlock()
		a.shutdownGate.RUnlock()
		log.Printf("Job %s already has a process-local terminal physical result; refusing duplicate dispatch and re-reporting", jobID)
		if err := a.updateJobStatus(sessionCtx, jobID, terminal.status, terminal.errMsg, fields.ClaimToken, terminal.spoolerJobID); err != nil {
			log.Printf("Job %s: failed to re-report process-local terminal result: %v", jobID, err)
		}
		return false
	}
	if _, dup := a.inFlight[jobID]; dup {
		// Never adopt a newer claim token while a physical attempt is already
		// executing locally. Doing so would let the original hardware attempt
		// finalize a newer Gateway claim and could make a second claimant look
		// authoritative while bytes are still in flight. The local ledger is
		// the final duplicate barrier; the newer delivery remains fenced by
		// its own token and is reconciled by the Gateway's unknown-outcome path.
		a.inFlightMu.Unlock()
		a.shutdownGate.RUnlock()
		log.Printf("Job %s is already in flight; duplicate delivery ignored without changing the active claim token.", jobID)
		return false
	}
	if pendingPrinter != "" && a.pendingByPrinter[pendingPrinter] >= maxPendingJobsPerPrinter {
		a.inFlightMu.Unlock()
		a.shutdownGate.RUnlock()
		log.Printf("Job %s dropped: printer %s has reached the per-printer pending ceiling (%d); handing it back to the gateway queue.", jobID, pendingPrinter, maxPendingJobsPerPrinter)
		a.enqueueReject(sessionCtx, jobID, fields.ClaimToken, "printer_pending_full")
		return false
	}
	a.inFlight[jobID] = struct{}{}
	if a.inFlightTokens == nil {
		a.inFlightTokens = make(map[string]string)
	}
	if a.inFlightReceived == nil {
		a.inFlightReceived = make(map[string]time.Time)
	}
	if a.pendingByPrinter == nil {
		a.pendingByPrinter = make(map[string]int)
	}
	if pendingPrinter != "" {
		a.pendingByPrinter[pendingPrinter]++
	}
	a.inFlightTokens[jobID] = fields.ClaimToken
	a.inFlightPrinters[jobID] = pendingPrinter
	a.inFlightReceived[jobID] = time.Now()
	a.wg.Add(1)
	a.inFlightMu.Unlock()
	a.shutdownGate.RUnlock()

	select {
	case a.pendingSlots <- struct{}{}:
	default:
		a.forgetJob(jobID)
		a.wg.Done() // undo the reservation; no goroutine will run
		log.Printf("Job %s dropped: %d jobs already in flight; handing it back to the gateway queue (pending_full).", jobID, maxPendingJobs)
		// Tell the gateway NOW so the job is requeued immediately instead of
		// sitting 'claimed' for the 90s lease. The gateway refunds the
		// delivery-attempt charge for this provably pre-execution return
		// (zero bytes sent) and consumes one retry instead, so a saturated
		// agent holding a big backlog cannot burn jobs into a delivery-budget
		// failure (see the reject gate in src/app/api/agent/jobs).
		// Best-effort: the lease reclaim is the backstop if this PATCH fails.
		a.enqueueReject(sessionCtx, jobID, fields.ClaimToken, "pending_full")
		return false
	}

	go func() {
		defer a.wg.Done()
		defer func() { <-a.pendingSlots }()
		defer a.forgetJob(jobID)
		// Recovery must be registered AFTER the slot-release defers so it runs
		// first (LIFO) and the cleanup defers still execute on panic.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("PANIC while executing job %s: %v", jobID, r)
				// A panic is phase-ambiguous: it may occur before admission, after
				// BeginPrint, or after physical bytes reached the device. Inspect and
				// terminalize the durable local ledger first. A row left in `printing`
				// would permit a later same-token redelivery to reopen the hardware
				// attempt after the in-process fence is cleaned up.
				_, localStatus, found, readErr := a.queue.Get(jobID)
				status, panicMsg := classifyPanicOutcome(readErr, found, localStatus, a.queue.WasOutcomeUnknown(jobID), r)
				if status == "failed" && strings.HasPrefix(panicMsg, "UNKNOWN_PARTIAL_DELIVERY: ") {
					if err := a.queue.UpdateStatusWithError(jobID, "failed", panicMsg); err != nil {
						a.rememberTerminalExecution(jobID, "failed", panicMsg, fields.ClaimToken, "")
					}
				}
				a.updateJobStatus(executionCtx, jobID, status, panicMsg, fields.ClaimToken, "")
			}
		}()

		a.processJob(executionCtx, job)
	}()
	return true
}

// staleClaimSafetyWindow is used only to describe delayed deliveries in
// diagnostics. Receipt age cannot establish Gateway claim ownership.
const staleClaimSafetyWindow = 90 * time.Second

// authorizeDispatchAfterReportFailure decides whether physical dispatch may
// proceed after the claimed->printing report did NOT come back accepted.
//
//   - Fence rejection (ErrStaleClaim) or any other explicit gateway
//     rejection (ErrTransitionRejected): the gateway evaluated our claim
//     and refused it. Another attempt may own the job. HARD STOP.
//   - Transport failure: the Gateway said nothing. A freshly received frame
//     may have waited in a proxy or socket buffer after its claim expired.
//     Never start hardware until the Gateway acknowledges printing.
//   - Unknown receipt time (zero): freshness cannot be proven. HARD STOP.
//
// The returned reason is recorded in the aborted ledger row for forensics.
func authorizeDispatchAfterReportFailure(receivedAt time.Time, now time.Time, reportErr error) (bool, string) {
	if reportErr == nil {
		return true, ""
	}
	if errors.Is(reportErr, ErrStaleClaim) {
		return false, "claim fence rejected by gateway"
	}
	if errors.Is(reportErr, ErrTransitionRejected) {
		return false, "gateway explicitly rejected the printing transition"
	}
	if receivedAt.IsZero() {
		return false, "delivery receipt time unknown; ownership freshness unprovable"
	}
	// TTL is authoritative in the Gateway database. The Agent deliberately
	// does NOT compare expiresAt against its Windows wall clock because that
	// clock can be skewed from the Gateway. Ownership freshness is measured
	// only with the local monotonic component of time.Time.
	if now.Sub(receivedAt) >= staleClaimSafetyWindow {
		return false, "delivery older than the claim-lease window; a reclaim may have completed"
	}
	return false, "printing transition was not acknowledged; receipt age cannot prove claim ownership"
}

// authorizeDispatchAfterReportFailure is the processJob-facing wrapper that
// reads the delivery receipt time tracked at dispatch acceptance.
func (a *Agent) authorizeDispatchAfterReportFailure(jobID string, reportErr error) (bool, string) {
	return authorizeDispatchAfterReportFailure(a.deliveryReceivedAt(jobID), time.Now(), reportErr)
}

func (a *Agent) forgetJob(id string) {
	a.inFlightMu.Lock()
	delete(a.inFlight, id)
	delete(a.inFlightTokens, id)
	delete(a.inFlightReceived, id)
	if printerID := a.inFlightPrinters[id]; printerID != "" {
		// Guard against negative counts: if the entry is already gone or
		// corrupted, don't let the counter go negative.
		if count, ok := a.pendingByPrinter[printerID]; ok {
			if count > 1 {
				a.pendingByPrinter[printerID] = count - 1
			} else {
				delete(a.pendingByPrinter, printerID)
			}
		}
	}
	delete(a.inFlightPrinters, id)
	// Decrement the per-printer pending count by recovering the printer ID from
	// the dispatch bookkeeping only when the job is still represented by the
	// executor map. The dedicated helper below is used by the normal goroutine
	// path before the map entry disappears.
	a.inFlightMu.Unlock()
}

func (a *Agent) rememberTerminalExecution(jobID, status, errMsg, claimToken, spoolerJobID string) {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	if a.terminalExecution == nil {
		a.terminalExecution = make(map[string]terminalExecutionResult)
	}
	a.terminalExecution[jobID] = terminalExecutionResult{status: status, errMsg: errMsg, claimToken: claimToken, spoolerJobID: spoolerJobID}
}

func (a *Agent) deliveryReceivedAt(jobID string) time.Time {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	return a.inFlightReceived[jobID]
}

// inFlightJobIDs returns up to limit ids of jobs currently held by the
// executor (waiting for an execution slot, running, or at the printer).
// Used for the heartbeat keep-alive (gateway print-lease extension).
// Each entry carries the delivery attempt's claim token: the gateway
// refreshes a lease ONLY when (jobId, claimToken, "") still matches the live
// claim, so a stale worker's heartbeat can never extend a reclaimed lease.
func (a *Agent) inFlightJobIDs(limit int) []map[string]string {
	if limit <= 0 {
		return nil
	}
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	if len(a.inFlight) == 0 {
		return nil
	}
	ids := make([]map[string]string, 0, len(a.inFlight))
	for id := range a.inFlight {
		ids = append(ids, map[string]string{"jobId": id, "claimToken": a.inFlightTokens[id]})
		if len(ids) >= limit {
			break
		}
	}
	return ids
}

// rejectJob hands a claimed job back to the gateway queue because the local
// executor is saturated (pendingSlots full). This is distinct from a real
// print failure: the agent is healthy, it just cannot accept the job right
// now. The gateway requeues it WITHOUT incrementing the retry budget, so a
// temporarily overloaded agent never drives a healthy backlog into
// 'exceeded max retries'. Best-effort — the gateway's 90s claim-lease
// reclaim remains the backstop if this request fails or races.
func (a *Agent) rejectJob(ctx context.Context, jobID, token, reason string) error {
	return a.rejectJobExact(ctx, jobID, token, reason)
}

// rejectJobExact is the fenced form used by the asynchronous rejection worker.
// Its claim token is immutable: it MUST NOT be replaced with a newer token
// that may now be active for the same job, otherwise an old saturation event
// could mutate the replacement claim.
func (a *Agent) rejectJobExact(ctx context.Context, jobID, token, reason string) error {
	reqURL := "/api/agent/jobs"
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": "queued",
		"reason": reason,
	}
	if token != "" {
		body["claimToken"] = token
	}
	resp, err := a.doAuthorizedRequest(ctx, "PATCH", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report pre-execution rejection: %v (claim lease remains the backstop)", jobID, err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Job %s: failed to read gateway rejection body: %v", jobID, readErr)
		}
		log.Printf("Job %s: server rejected the pre-execution rejection (%d): %s", jobID, resp.StatusCode, string(respBody))
		return fmt.Errorf("gateway rejected job hand-back: HTTP %d", resp.StatusCode)
	}
	return nil
}

func rejectKey(jobID, token, reason string) string {
	return jobID + "\x00" + token + "\x00" + reason
}

// enqueueReject never performs network I/O. It registers at most one queued
// rejection per (job, claim token, reason), then places it into a bounded
// channel. A full queue deliberately drops the best-effort signal: the
// Gateway's lease/reclaim path is the authoritative recovery backstop.
func (a *Agent) enqueueReject(ctx context.Context, jobID, token, reason string) bool {
	if jobID == "" {
		return false
	}
	key := rejectKey(jobID, token, reason)

	a.rejectMu.Lock()
	if _, exists := a.rejectPending[key]; exists {
		a.rejectMu.Unlock()
		return true
	}
	work := rejectWork{ctx: ctx, jobID: jobID, claimToken: token, reason: reason, key: key}
	select {
	case <-ctx.Done():
		a.rejectMu.Unlock()
		return false
	case a.rejectQueue <- work:
		a.rejectPending[key] = struct{}{}
		a.rejectMu.Unlock()
		return true
	default:
		a.rejectMu.Unlock()
		log.Printf("Job %s: rejection queue full (%d); relying on gateway claim lease for recovery", jobID, maxRejectQueue)
		return false
	}
}

// runRejectWorker is the only owner that performs queued pre-execution
// rejection network calls. It is tracked by runtimeWG, consumes a bounded
// queue, and uses the original session context so disconnect/shutdown cancels
// stale work instead of mutating a newer lifecycle.
func (a *Agent) runRejectWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case work := <-a.rejectQueue:
			if err := work.ctx.Err(); err == nil {
				if err := a.rejectJobExact(work.ctx, work.jobID, work.claimToken, work.reason); err != nil {
					log.Printf("job rejection callback failed for %s: %v", work.jobID, err)
				}
			}
			a.rejectMu.Lock()
			delete(a.rejectPending, work.key)
			a.rejectMu.Unlock()
		}
	}
}

// waitForJobs blocks until in-flight job handlers finish (bounded by
// shutdownGrace), so the SQLite queue is never closed mid-write on service
// stop. Surviving the deadline is safe: WAL is crash-durable and the gateway
// reclaims stale claimed jobs automatically.
//
// Caller contract (sync.WaitGroup rule): no wg.Add may be concurrent with
// this Wait. Production shutdown satisfies it via the inFlightMu gate in
// dispatchJob. Tests driving delivery from a background goroutine (WS
// handler) must first synchronize past the Add — e.g. the WS ack alone is
// NOT enough, it is sent before dispatchJob runs; wait for the print to
// start (see waitForPrintStarted) before calling this.
func (a *Agent) inFlightCount() int {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	return len(a.inFlight)
}

// waitForJobs waits using the same in-flight ownership map that gates
// dispatch. This avoids spawning an untracked WaitGroup waiter that would
// itself survive a timeout. The map reaches zero before the job goroutine's
// final WaitGroup Done, so the caller performs wg.Wait() only after the
// shutdown gate has stopped all future Add operations.
func (a *Agent) waitForJobs() bool {
	return a.waitForJobsFor(shutdownGrace)
}

func (a *Agent) waitForJobsFor(grace time.Duration) bool {
	if grace <= 0 {
		grace = time.Millisecond
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()

	for {
		if a.inFlightCount() == 0 {
			a.wg.Wait()
			log.Println("All in-flight jobs finished cleanly.")
			return true
		}
		select {
		case <-timer.C:
			log.Printf("WARNING: shutdown grace period (%s) reached with jobs still in flight.", grace)
			return false
		case <-ticker.C:
		}
	}
}

func printerLockIndex(printerID string) int {
	const (
		fnvOffset64 = uint64(14695981039346656037)
		fnvPrime64  = uint64(1099511628211)
	)
	hash := fnvOffset64
	for i := 0; i < len(printerID); i++ {
		hash ^= uint64(printerID[i])
		hash *= fnvPrime64
	}
	return int(hash % printerLockShards)
}

func (a *Agent) getPrinterLock(printerID string) *sync.Mutex {
	return &a.jobLocks[printerLockIndex(printerID)]
}

// sendHeartbeatGuarded makes heartbeat ticks non-reentrant: if the previous
// heartbeat is still running (slow gateway, many offline printers) the tick
// is skipped instead of queueing up duplicate probes and HTTP calls.

// sendHeartbeatGuardedContext makes production heartbeat ticks cancellable by
// the Agent lifecycle while preserving the background-context helper used by
// direct diagnostic tests.
func (a *Agent) sendHeartbeatGuardedContext(ctx context.Context) {
	if !a.hbMu.TryLock() {
		return
	}
	defer a.hbMu.Unlock()
	a.sendHeartbeatContext(ctx)
}

// pollJobsGuarded is the non-reentrant variant for the poll fallback.
func (a *Agent) pollJobsGuarded(ctx context.Context) {
	if !a.pollMu.TryLock() {
		return
	}
	defer a.pollMu.Unlock()
	a.pollJobs(ctx)
}

// printerStatusPayload builds the printer-sync block sent on every
// heartbeat, using the agent's OWN view of its configured printers - the
// server must never be trusted to tell an agent what printers it has.
// It now reports the full discovery model: connectionType, protocol,
// spooler_name, etc., so Gateway can store canonical printer registry and
// route jobs by branch/destination/documentType without relying on YAML.
// deviceFacts returns the declared transport facts for one configured
// printer (protocol + explicit capability list) used by the precise
// payload/device capability gate.
func (a *Agent) deviceFacts(printerID string) (printer.TransportFacts, bool) {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	pc, ok := a.printerConfigs[printerID]
	if !ok {
		return printer.TransportFacts{}, false
	}
	proto, err := pc.NormalizedProtocol()
	family := proto
	if err != nil {
		family = "unknown"
	}
	var caps []string
	supportedProtocolsDeclared := false
	if explicit, ok := pc.Capabilities["supported_protocols"].([]interface{}); ok {
		supportedProtocolsDeclared = true
		for _, v := range explicit {
			if str, ok := v.(string); ok {
				caps = append(caps, strings.ToLower(strings.TrimSpace(str)))
			}
		}
	} else if explicit, ok := pc.Capabilities["supported_protocols"].([]string); ok {
		supportedProtocolsDeclared = true
		caps = explicit
	}
	return printer.TransportFacts{
		Protocol:                  family,
		Connection:                pc.NormalizedType(),
		SupportedProtocol:         caps,
		SupportedProtocolDeclared: supportedProtocolsDeclared,
	}, true
}

func (a *Agent) gatewayOwnedPrinterIDs() []string {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()

	ids := make([]string, 0, len(a.gatewayOwned)+len(a.gatewayTombstones))
	seen := make(map[string]struct{}, len(a.gatewayOwned)+len(a.gatewayTombstones))
	for id := range a.gatewayOwned {
		ids = append(ids, id)
		seen[id] = struct{}{}
	}
	for id := range a.gatewayTombstones {
		if _, ok := seen[id]; !ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (a *Agent) printerStatusPayload() []map[string]interface{} {
	// Snapshot the printer map under the read lock: the async discovery
	// goroutine may add printers while heartbeats probe statuses.
	a.printersMu.RLock()
	ids := make([]string, 0, len(a.printers))
	for id := range a.printers {
		ids = append(ids, id)
	}
	printerByID := make(map[string]printer.Printer, len(a.printers))
	configByID := make(map[string]config.PrinterConfig, len(a.printerConfigs))
	for id, p := range a.printers {
		printerByID[id] = p
	}
	for id, pc := range a.printerConfigs {
		configByID[id] = pc
	}
	a.printersMu.RUnlock()
	sort.Strings(ids) // deterministic order aids gateway-side diffing

	statuses := make([]string, len(ids))
	// Probe results flow back through a bounded worker pool. The old heartbeat
	// ceiling implicitly capped this at 500 goroutines; once inventory became
	// paginated, keeping one goroutine per printer would turn a large fleet
	// heartbeat into an unbounded local resource spike. Keep per-printer
	// single-flight semantics, but cap simultaneous OS/RPC status calls.
	type probeResult struct {
		idx    int
		status string
	}
	type probeWork struct {
		idx   int
		pid   string
		p     printer.Printer
		state *printerProbeState
	}

	results := make(chan probeResult, len(ids))
	works := make([]probeWork, 0, len(ids))
	probed := make([]bool, len(ids))
	for i, id := range ids {
		state := a.getProbeState(id)
		if !state.running.CompareAndSwap(false, true) {
			// A previous probe is still running in the OS/RPC driver!
			// Do NOT spawn another goroutine. Reuse the last known status.
			statuses[i] = a.probeLastStatus(id)
			probed[i] = true
			continue
		}
		works = append(works, probeWork{idx: i, pid: id, p: printerByID[id], state: state})
	}

	workers := len(works)
	if workers > maxHeartbeatProbeConcurrency {
		workers = maxHeartbeatProbeConcurrency
	}
	var probeWG sync.WaitGroup
	probeWG.Add(workers)
	workQueue := make(chan probeWork, len(works))
	for i := 0; i < workers; i++ {
		go func() {
			defer probeWG.Done()
			for work := range workQueue {
				func() {
					defer func() {
						work.state.running.Store(false)
						a.deleteProbeState(work.pid)
					}()
					status := "error"
					func() {
						defer func() {
							if r := recover(); r != nil {
								log.Printf("Status probe panic for %s: %v", work.pid, r)
							}
						}()
						status = work.p.Status()
					}()
					a.setProbeLastStatus(work.pid, status)
					a.observeDesiredRevision(work.pid, status)
					results <- probeResult{idx: work.idx, status: status}
				}()
			}
		}()
	}

	for _, work := range works {
		workQueue <- work
	}
	close(workQueue)

	pendingProbes := len(works)
	// Hard probe budget: the heartbeat must never block indefinitely on a
	// wedged driver. Each individual probe already has its own timeout
	// (spooler 5s, network 2s, IPP 5s), but a fleet of slow printers could
	// still exceed the heartbeat HTTP budget. After 10s total, stop waiting:
	// slow printers keep their last-known status and their helpers finish in
	// the background (single-flight guarantees at most one stuck helper per
	// printer, and the bounded pool caps total helpers). The next heartbeat
	// reuses the cached result until the stuck probe clears.
	// A bad printer probe must never make the Agent appear offline.
	budgetTimer := time.NewTimer(10 * time.Second)
	defer budgetTimer.Stop()
	var warningC <-chan time.Time = budgetTimer.C
	for pendingProbes > 0 {
		select {
		case res := <-results:
			statuses[res.idx] = res.status
			probed[res.idx] = true
			pendingProbes--
		case <-warningC:
			warningC = nil
			deferred := 0
			for i, id := range ids {
				if !probed[i] {
					statuses[i] = a.probeLastStatus(id)
					if statuses[i] == "" {
						statuses[i] = "unknown"
					}
					probed[i] = true
					pendingProbes--
					deferred++
				}
			}
			log.Printf("WARNING: Printer status probe batch exceeded 10s budget; %d slow probe(s) deferred to background (last-known status reported)", deferred)
		}
	}
	// Slow helpers are single-flight per printer and self-clearing; joining
	// them here would reintroduce the heartbeat stall this budget removes.

	observedCapabilityStateChanged := false
	result := make([]map[string]interface{}, 0, len(ids))
	for i, id := range ids {
		pc := configByID[id]
		nt := pc.NormalizedType()
		// An undeclared protocol reports honestly as "unknown" (never a
		// default "raw"); the gateway capability model will not route to it.
		proto := pc.NormalizedProtocolOrUnknown()
		// printer_type historically held either a printer class
		// (physical|virtual|redirected) or a device class
		// (thermal|laser|inkjet|label|other). The Gateway validates the two
		// wire fields against separate enums, so a device class is only
		// reported when the configured value really is one; otherwise the
		// Gateway rejected the entire entry with
		// invalid_device_class_or_printer_type and the inventory never
		// converged (every printer_type: physical printer was dropped on every
		// heartbeat). normalizeDeviceClass is the same normalization discovery
		// already applies to its payload.
		deviceClass := normalizeDeviceClass(pc.PrinterType)
		printerType := normalizePrinterType(pc.PrinterType)
		// Build payload with all required fields for Gateway inventory
		entry := map[string]interface{}{
			"id":             id,
			"name":           heartbeatPrinterName(pc.Name, id),
			"displayName":    boundedDiscoveryText(pc.Name, 255),
			"printerType":    printerType,
			"deviceClass":    deviceClass,
			"connectionType": nt,
			"protocol":       proto,
			"status":         statuses[i],
			"config":         endpointToConfig(pc),
		}
		// Include USB identifiers if present
		if pc.USBVID != "" {
			entry["usbVid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			entry["usbPid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			entry["usbSerial"] = pc.USBSerial
		}
		if pc.SpoolerName != "" {
			entry["spoolerName"] = pc.SpoolerName
		}
		if pc.Endpoint != "" {
			entry["endpoint"] = pc.Endpoint
		}
		// Network address/port for network and IPP printers
		if nt == "network" || nt == "ipp" || nt == "ipps" {
			if host, portStr, err := net.SplitHostPort(pc.Endpoint); err == nil {
				entry["networkAddress"] = host
				if p, err := strconv.Atoi(portStr); err == nil {
					entry["port"] = p
				}
			} else {
				// Try IPP URL parsing
				lowerEP := strings.ToLower(pc.Endpoint)
				parseStr := pc.Endpoint
				if strings.HasPrefix(lowerEP, "ipp://") {
					parseStr = "http://" + pc.Endpoint[6:]
				} else if strings.HasPrefix(lowerEP, "ipps://") {
					parseStr = "https://" + pc.Endpoint[7:]
				}
				if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
					entry["networkAddress"] = u.Hostname()
					if p := u.Port(); p != "" {
						if port, err := strconv.Atoi(p); err == nil {
							entry["port"] = port
						}
					} else {
						entry["port"] = 631
					}
				}
			}
		}
		// Capabilities: always report which document kinds this backend can
		// physically print, so the gateway routing layer can reject an
		// incompatible job before it is ever queued. An explicitly configured
		// supported_protocols list is left untouched.
		caps := make(map[string]interface{}, len(pc.Capabilities)+1)
		for k, v := range pc.Capabilities {
			if k == "_raw" {
				continue
			}
			caps[k] = v
		}
		facts, found := a.deviceFacts(id)
		if !found {
			log.Printf("[printer] device facts unavailable for %s; using unknown transport capabilities", id)
		}
		if _, ok := caps["supported_protocols"]; !ok {
			// Derive the honest protocol list from the declared transport
			// (mirrors the canonical capability table); never invent
			// cross-protocol compatibility.
			caps["supported_protocols"] = printer.SupportedProtocolsForDevice(facts)
		}
		if reporter, ok := printerByID[id].(interface{ StatusDetail() string }); ok {
			if detail := strings.TrimSpace(reporter.StatusDetail()); detail != "" {
				caps["status_detail"] = boundedDiscoveryText(detail, 255)
			}
		}
		if facts.SupportedProtocolDeclared {
			a.desiredStateMu.Lock()
			if row, managed := a.desiredStates[id]; managed {
				observed := append([]string(nil), facts.SupportedProtocol...)
				if !row.ObservedSupportedProtocolsKnown || !reflect.DeepEqual(row.ObservedSupportedProtocols, observed) {
					row.ObservedSupportedProtocols = observed
					row.ObservedSupportedProtocolsKnown = true
					a.desiredStates[id] = row
					observedCapabilityStateChanged = true
				}
			}
			a.desiredStateMu.Unlock()
		}
		if len(caps) > 0 {
			entry["capabilities"] = caps
		}
		result = append(result, entry)
	}
	if observedCapabilityStateChanged {
		if err := a.persistDesiredState(); err != nil {
			log.Printf("WARNING: failed to persist observed printer capabilities: %v", err)
		}
	}
	return result
}

// Heartbeat names are display metadata, bounded to the Gateway's UTF-16
// limit. Keep the full spooler name/endpoint in config for hardware identity.
func heartbeatPrinterName(name, id string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = id
	}
	return boundedDiscoveryText(name, 100)
}

// endpointToConfig normalizes the agent's local endpoint into the gateway's
// printer.config shape. Handles tcp, spooler, usb, ipp and includes USB metadata.
func endpointToConfig(pc config.PrinterConfig) map[string]interface{} {
	proto := pc.NormalizedProtocolOrUnknown()
	cfgMap := map[string]interface{}{"protocol": proto}
	nt := pc.NormalizedType()
	switch nt {
	case "network":
		host, portStr, err := net.SplitHostPort(pc.Endpoint)
		if err == nil {
			cfgMap["ip"] = host
			if port, err := strconv.Atoi(portStr); err == nil {
				cfgMap["port"] = port
			}
		} else {
			cfgMap["ip"] = pc.Endpoint
		}
	case "spooler":
		spoolerName := pc.SpoolerName
		if spoolerName == "" {
			spoolerName = pc.Endpoint
		}
		cfgMap["spooler_name"] = spoolerName
		cfgMap["address"] = spoolerName
		// Include underlying USB info if spooler is USB-backed
		if pc.USBVID != "" {
			if vid, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(pc.USBVID, "0x"), "0X"), 16, 16); err == nil {
				cfgMap["vid"] = int(vid)
			}
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			if pid, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(pc.USBPID, "0x"), "0X"), 16, 16); err == nil {
				cfgMap["pid"] = int(pid)
			}
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
	case "usb":
		cfgMap["address"] = pc.Endpoint
		if pc.SpoolerName != "" {
			cfgMap["spooler_name"] = pc.SpoolerName
		}
		if pc.USBVID != "" {
			if vid, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(pc.USBVID, "0x"), "0X"), 16, 16); err == nil {
				cfgMap["vid"] = int(vid)
			}
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			if pid, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(pc.USBPID, "0x"), "0X"), 16, 16); err == nil {
				cfgMap["pid"] = int(pid)
			}
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
		// Add diagnostic if direct USB without spooler
		if pc.SpoolerName == "" {
			cfgMap["diagnostic"] = "Direct USB transport requires a Windows device interface path; use a spooler_name only for Windows print-queue transport"
		}
	case "ipp", "ipps":
		cfgMap["address"] = pc.Endpoint
		cfgMap["ipp_url"] = pc.Endpoint
		// Try to extract host/port from URL for gateway
		lowerEP := strings.ToLower(pc.Endpoint)
		parseStr := pc.Endpoint
		if strings.HasPrefix(lowerEP, "ipp://") {
			parseStr = "http://" + pc.Endpoint[6:]
		} else if strings.HasPrefix(lowerEP, "ipps://") {
			parseStr = "https://" + pc.Endpoint[7:]
		}
		if u, err := url.Parse(parseStr); err == nil && u.Host != "" {
			cfgMap["ip"] = u.Hostname()
			if p := u.Port(); p != "" {
				if port, err := strconv.Atoi(p); err == nil {
					cfgMap["port"] = port
				}
			} else {
				cfgMap["port"] = 631
			}
			cfgMap["host"] = u.Host
		} else {
			cfgMap["ip"] = pc.Endpoint
		}
	default:
		cfgMap["address"] = pc.Endpoint
	}
	// Include capabilities if present. Reserved identity keys declared on
	// the printer config must never be overwritten by a capability bag.
	// _raw is a legacy invalid-JSON marker that must never leak into the
	// Gateway heartbeat inventory.
	if pc.Capabilities != nil {
		for k, v := range pc.Capabilities {
			switch k {
			case "protocol", "address", "ip", "port", "printer_type", "_raw":
				continue
			}
			cfgMap[k] = v
		}
	}
	// Legacy alias
	if pc.PrinterType != "" {
		cfgMap["printer_type"] = pc.PrinterType
	}
	return cfgMap
}

func (a *Agent) reconcileRegistryPrinters(infos []printer.DeviceInfo) {
	// Gateway-owned printer IDs remain authoritative until the Gateway desired
	// state explicitly removes them. A stale printers.json entry must never
	// re-enter the runtime registry during the heartbeat preflight.
	infos = a.filterGatewayOwned(infos)

	yamlOwned := make(map[string]struct{}, len(a.cfg.Printers))
	for _, pc := range a.cfg.Printers {
		yamlOwned[pc.ID] = struct{}{}
	}

	present := make(map[string]struct{}, len(infos))
	for _, di := range infos {
		if _, ownedByYAML := yamlOwned[di.ID]; ownedByYAML {
			continue
		}
		// A registry row only owns a runtime slot after its backend has been
		// constructed successfully. Marking it present before merge would let a
		// newly-invalid transport/config keep an older backend alive under the
		// same ID, so heartbeat/dispatch could continue using stale endpoint or
		// capability facts that no longer match the authoritative registry row.
		if _, err := a.mergeDiscoveredPrinter(di); err != nil {
			log.Printf("WARNING: registry printer %q (%s) not initialized: %v", di.ID, di.Name, err)
			continue
		}
		present[di.ID] = struct{}{}
	}

	a.printersMu.Lock()
	var removed []string
	for id := range a.registryOwned {
		if _, gatewayManaged := a.gatewayOwned[id]; gatewayManaged {
			continue
		}
		if _, stillPresent := present[id]; stillPresent {
			continue
		}
		removed = append(removed, id)
	}
	a.registryOwned = present
	a.printersMu.Unlock()

	// Registry removals are local lifecycle changes too. Serialize them with
	// physical execution so a stale discovery sweep cannot delete the backend
	// out from under an active print.
	for _, id := range removed {
		lock := a.getPrinterLock(id)
		lock.Lock()
		a.printersMu.Lock()
		if _, gatewayManaged := a.gatewayOwned[id]; !gatewayManaged {
			if _, stillPresent := present[id]; !stillPresent {
				delete(a.printers, id)
				delete(a.printerConfigs, id)
			}
		}
		a.printersMu.Unlock()
		lock.Unlock()
		a.deleteProbeState(id)
	}
}

func (a *Agent) reloadRegistryPrinters() bool {
	if a.registryPath == "" {
		return true
	}
	infos, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil {
		log.Printf("WARNING: failed to reload printer registry: %v", err)
		return false
	}
	// Old releases could persist candidate-only LPR observations even though
	// there is no LPR execution backend. Keep those historical rows from
	// re-entering runtime reconciliation/heartbeat after upgrade.
	infos = printer.RuntimeDiscoveryPrinters(infos)
	a.reconcileRegistryPrinters(infos)
	return true
}

func (a *Agent) sendHeartbeatContext(parent context.Context) {
	if parent.Err() != nil {
		return
	}
	inventoryComplete := a.reloadRegistryPrinters()
	if parent.Err() != nil {
		return
	}
	reqURL := "/api/agent/heartbeat"
	printerPayload := a.printerStatusPayload()
	desiredAcks := a.desiredStateAcksPayload()
	gatewayOwnedIDs := a.gatewayOwnedPrinterIDs()

	// Heartbeats are paginated at the transport boundary. The Gateway still
	// enforces 500 printers / page, but the Agent never truncates a real
	// inventory: every printer is delivered across one or more pages. The
	// auxiliary desired-state ACKs are paginated too, while Gateway-owned IDs
	// are scoped to the printer IDs in the same page so a stale local registry
	// entry can never bypass the ownership fence merely because it landed on a
	// different page.
	keepAlive := a.inFlightJobIDs(64)
	pages := buildHeartbeatPayloadPages(printerPayload, desiredAcks, gatewayOwnedIDs, keepAlive, inventoryComplete)
	for pageIndex, payload := range pages {
		if parent.Err() != nil {
			return
		}
		payload["desiredStatePaging"] = true

		heartbeatCtx, cancel := context.WithTimeout(parent, 15*time.Second)
		resp, err := a.doAuthorizedRequest(heartbeatCtx, "POST", reqURL, payload)
		if err != nil {
			cancel()
			log.Printf("Heartbeat page %d/%d failed: %v", pageIndex+1, len(pages), err)
			return
		}

		// The response body must be read BEFORE the request context is canceled.
		// Cancelling first aborted the body read, which produced
		// "response read failed: context canceled" on every cycle and returned
		// early — skipping desired-state reconciliation and the SkippedPrinters
		// feedback entirely. The 15s budget still bounds request + body read.
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxHeartbeatBytes+1))
		cancel()
		_ = resp.Body.Close()
		if readErr != nil || len(body) > maxHeartbeatBytes {
			if pageIndex == len(pages)-1 {
				a.desiredStateMu.Lock()
				a.desiredStateSynced = false
				a.desiredStateMu.Unlock()
			}
			log.Printf("Heartbeat page %d/%d response read failed or exceeded the byte limit: %v", pageIndex+1, len(pages), readErr)
			return
		}
		if resp.StatusCode >= 300 {
			if pageIndex == len(pages)-1 {
				a.desiredStateMu.Lock()
				a.desiredStateSynced = false
				a.desiredStateMu.Unlock()
			}
			if resp.StatusCode == http.StatusConflict {
				var conflict struct {
					Code                   string `json:"code"`
					MinimumSnapshotVersion string `json:"minimumSnapshotVersion"`
				}
				if json.Unmarshal(body, &conflict) == nil && conflict.Code == "INVENTORY_SNAPSHOT_CONFLICT" {
					heartbeatInventoryClock.observe(conflict.MinimumSnapshotVersion)
				}
			}
			log.Printf("Heartbeat page %d/%d rejected (%d): %s", pageIndex+1, len(pages), resp.StatusCode, string(body))
			a.noteHeartbeatRejection(resp.StatusCode, body)
			return
		}
		if parent.Err() != nil {
			return
		}

		var hbResp struct {
			Success                     bool                  `json:"success"`
			DesiredState                *[]desiredPrinterWire `json:"desiredState"`
			DesiredStateNextCursor      string                `json:"desiredStateNextCursor"`
			DesiredStateUpgradeRequired bool                  `json:"desiredStateUpgradeRequired"`
			SkippedPrinters             []struct {
				ID     string `json:"id"`
				Reason string `json:"reason"`
			} `json:"skippedPrinters"`
		}
		if err := json.Unmarshal(body, &hbResp); err != nil || !hbResp.Success {
			// A final page is the only authoritative desired-state snapshot.
			// Retaining a previous sync after an invalid 2xx response would
			// allow stale manager configuration to remain executable. Fail closed
			// until the next complete snapshot can be parsed.
			if pageIndex == len(pages)-1 {
				a.desiredStateMu.Lock()
				a.desiredStateSynced = false
				a.desiredStateMu.Unlock()
				log.Printf("Heartbeat page %d/%d returned an invalid final response; desired-state execution fence enabled: parse error=%v, success=%t", pageIndex+1, len(pages), err, hbResp.Success)
				return
			}
			continue
		}

		if parent.Err() != nil {
			return
		}
		// Only the final page carries a desired-state snapshot on the modern
		// Gateway. Keep the local execution fence unchanged while intermediate
		// pages are in flight.
		if pageIndex == len(pages)-1 {
			if hbResp.DesiredState != nil {
				a.desiredStateMu.Lock()
				a.desiredStateSynced = false
				a.desiredStateMu.Unlock()
				desired, syncErr := a.collectGatewayDesiredState(parent, *hbResp.DesiredState, hbResp.DesiredStateNextCursor)
				if syncErr != nil {
					log.Printf("desired-state synchronization incomplete; execution remains fenced: %v", syncErr)
					return
				}
				if !a.reconcileGatewayDesiredState(desired) {
					log.Printf("desired-state persistence failed; execution remains fenced")
					return
				}
				a.desiredStateMu.Lock()
				a.desiredStateSynced = true
				a.desiredStateMu.Unlock()
			} else {
				if hbResp.DesiredStateUpgradeRequired {
					log.Printf("Gateway requires paginated desired-state support; upgrade the Agent before manager-owned printing")
				}
				// Older gateways without the full desired-state contract are not
				// allowed to make a manager-owned printer executable.
				a.desiredStateMu.Lock()
				a.desiredStateSynced = false
				a.desiredStateMu.Unlock()
			}
		}
		if len(hbResp.SkippedPrinters) > 0 {
			for _, sp := range hbResp.SkippedPrinters {
				log.Printf("[heartbeat] printer %q rejected by gateway: %s", sp.ID, sp.Reason)
			}
		}
	}
	// Every page was accepted: this heartbeat cycle carries fresh proof the
	// Gateway still wants this agent. Release any lifecycle fence/backoff so
	// a re-enabled (or re-keyed) agent resumes autonomously.
	a.clearLifecycleFence()
}

func (a *Agent) pollJobs(ctx context.Context) {
	reqURL := "/api/agent/jobs"
	resp, err := a.doAuthorizedRequest(ctx, "GET", reqURL, nil)
	if err != nil {
		log.Printf("Poll failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Poll rejected (%d); failed to read error body: %v", resp.StatusCode, readErr)
		}
		log.Printf("Poll rejected (%d): %s", resp.StatusCode, string(body))
		return
	}

	var jobs []map[string]interface{}
	if err := json.NewDecoder(io.LimitReader(resp.Body, pollJobsByteLimit)).Decode(&jobs); err != nil {
		log.Printf("Poll: failed to decode job list: %v", err)
		return
	}

	for _, job := range jobs {
		a.dispatchJob(ctx, job)
	}
}

// processJob executes exactly one print job end-to-end and reports the
// true outcome. It NEVER reports "success" unless the payload was
// actually transmitted to the printer backend without error. "Success"
// here means "the bytes were handed to the printer over the configured
// transport" - for RAW TCP that means the socket write succeeded, NOT
// that paper physically came out. See PRINTERS.md for the documented
// delivery semantics.
//
// Callers should normally schedule it through dispatchJob; the tests drive
// it directly.
func (a *Agent) processJob(ctx context.Context, job map[string]interface{}) {
	fields, err := decodeJobFields(job)
	if err != nil {
		log.Printf("Received malformed job; rejecting execution: %v", err)
		return
	}
	requestID := fields.RequestID
	jobID := fields.ID
	printerID := fields.PrinterID
	receivedAt := a.deliveryReceivedAt(jobID)
	if receivedAt.IsZero() {
		receivedAt = time.Now()
	}
	log.Printf("print.trace agent_receive request_id=%s job_id=%s printer_id=%s queue_wait_ms=%d received_unix_ms=%d", requestID, jobID, printerID, time.Since(receivedAt).Milliseconds(), receivedAt.UnixMilli())
	claimToken := fields.ClaimToken
	if fields.AgentID != a.cfg.Agent.ID {
		log.Printf("Received job %s for agent %s on agent %s; rejecting before execution", jobID, fields.AgentID, a.cfg.Agent.ID)
		return
	}

	if jobID == "" || printerID == "" {
		// Never log the job map: it can embed the full print payload
		// (customer names, amounts). Log only the offending field names.
		missing := "id"
		if jobID != "" {
			missing = "printerId"
		}
		log.Printf("Received malformed job (missing %s, job present: %v); ignoring", missing, job != nil)
		return
	}

	// Local idempotency: a job that already printed successfully on THIS
	// agent is never printed again, no matter how often it is delivered. The
	// stored terminal result is re-reported with the CURRENT delivery's
	// claim token so it passes the gateway's fencing predicate.
	//
	// A locally FAILED job with a PROVABLE not-printed outcome is retryable
	// (the gateway only re-delivers after a fenced reclaim that increments
	// its retry budget). A locally failed job whose outcome is UNKNOWN
	// (partial delivery, crash mid-print) is NEVER reprinted unless the
	// operator explicitly enabled reprint_after_crash (documented, opt-in
	// at-least-once behavior).
	if _, localStatus, found, err := a.queue.Get(jobID); err != nil {
		// The local ledger is the evidence base for all duplicate-print
		// protection. If it cannot be read we cannot prove this job has not
		// printed; refuse before dispatch (no bytes sent, safe retry).
		log.Printf("Job %s: local queue lookup failed; refusing dispatch: %v", jobID, err)
		// Fenced pre-execution return (never dispatched, zero bytes sent):
		// the gateway requeues without burning the retry budget.
		a.rejectJob(ctx, jobID, claimToken, "ledger_unavailable")
		return
	} else if found && localStatus == "success" {
		log.Printf("Job %s already completed locally (success). Re-reporting terminal result instead of printing again.", jobID)
		a.updateJobStatus(ctx, jobID, "success", "", claimToken, "")
		return
	} else if found && a.queue.WasOutcomeUnknown(jobID) && !a.cfg.ReprintAfterCrashEnabled() {
		// This job already reached the printer in a previous attempt, so it
		// may have produced paper. With reprint_after_crash disabled the
		// agent refuses to print it a second time and re-reports the
		// unknown outcome instead of silently duplicating the document.
		// The LOCAL history is echoed verbatim (crash marker stays a crash
		// marker; partial delivery stays a partial-delivery marker).
		marker := "UNKNOWN_PARTIAL_DELIVERY"
		if a.queue.WasInterrupted(jobID) {
			marker = queue.InterruptedMarker
		}
		reason := marker + ": refusing to reprint a job whose previous attempt had an unknown outcome (agent.reprint_after_crash=false); the earlier delivery may have produced output"
		log.Printf("Job %s: %s", jobID, reason)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}

	pl, err := payload.Parse(job["payload"])
	if err != nil {
		log.Printf("Job %s has an invalid payload: %v", jobID, err)
		a.updateJobStatus(ctx, jobID, "failed", fmt.Sprintf("invalid payload: %v", err), claimToken, "")
		return
	}

	kind := string(pl.Type)

	log.Printf("Printing job %s on printer %s (%d bytes, type=%s, path=%s)", jobID, printerID, len(pl.Data), pl.Type, kind)

	// The durable local ledger is established before the gateway is told this
	// delivery reached the printing stage. This is the local evidence base
	// that survives a crash.
	ledgerStart := time.Now()
	if err := a.queue.BeginPrint(jobID, printerID, pl.Data, claimToken, a.cfg.ReprintAfterCrashEnabled()); err != nil {
		if errors.Is(err, queue.ErrAlreadyPrinting) {
			log.Printf("Job %s: duplicate delivery for the live local claim; suppressing a second physical dispatch", jobID)
			return
		}
		if errors.Is(err, queue.ErrTerminalState) {
			log.Printf("Job %s: local ledger is terminal; refusing dispatch and re-reporting stored outcome", jobID)
			_, storedStatus, found, getErr := a.queue.Get(jobID)
			if getErr != nil {
				log.Printf("Job %s: failed to read local terminal state: %v", jobID, getErr)
				found = false
			}
			if found && storedStatus == "success" {
				a.updateJobStatus(ctx, jobID, "success", "", claimToken, "")
			} else {
				marker := "UNKNOWN_PARTIAL_DELIVERY"
				if a.queue.WasInterrupted(jobID) {
					marker = queue.InterruptedMarker
				}
				a.updateJobStatus(ctx, jobID, "failed", marker+": local ledger terminal with an unknown outcome; this delivery was not dispatched (agent.reprint_after_crash=false)", claimToken, "")
			}
			return
		}
		log.Printf("Job %s: local durable ledger unavailable; refusing dispatch (no bytes sent): %v", jobID, err)
		a.rejectJob(ctx, jobID, claimToken, "ledger_unavailable")
		return
	}
	log.Printf("print.trace local_ledger_ready request_id=%s job_id=%s printer_id=%s ledger_latency_ms=%d", requestID, jobID, printerID, time.Since(ledgerStart).Milliseconds())

	// Serialize Gateway aliases and bare local IDs on the same backend.
	// Admission must follow all local waits so TTL and lifecycle are checked
	// immediately before hardware, using the Gateway database clock.
	gatewayPrinterID := printerID
	localPrinterID := a.resolvePrinterAlias(printerID)

	lock := a.getPrinterLock(localPrinterID)
	lock.Lock()
	defer lock.Unlock()

	if ctx.Err() != nil {
		a.queue.AbortPrint(jobID, "dispatch_refused: agent context cancelled while waiting for printer execution; zero bytes transmitted")
		return
	}

	if !a.isPrinterExecutionAllowed(localPrinterID) {
		a.queue.AbortPrint(jobID, "printer_not_at_desired_state")
		a.rejectJob(ctx, jobID, claimToken, "printer_not_at_desired_state")
		return
	}
	// Two agents in one tenant can share local discovery coordinates; the
	// Gateway then addresses this agent's device under a deterministic
	// "<local>~<agent>" alias. Recover the local backend: exact local IDs
	// always win, so an operator-configured overlapping ID is never
	// shadowed by suffix stripping.
	printerID = localPrinterID
	p, ok := a.getPrinter(printerID)
	if !ok {
		a.queue.AbortPrint(jobID, "printer_not_configured")
		a.updateJobStatus(ctx, jobID, "failed", fmt.Sprintf("printer %s is not configured on this agent", printerID), claimToken, "")
		return
	}
	if !printer.SupportsKind(p, kind) {
		a.queue.AbortPrint(jobID, "capability_kind_mismatch")
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s cannot print %s payloads", printerID, kind)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}
	facts, factsOK := a.deviceFacts(printerID)
	if !factsOK {
		a.queue.AbortPrint(jobID, "device_facts_missing")
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s has no declared device facts on this agent", printerID)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}
	if compatible, why := printer.PayloadCompatibleForDevice(kind, pl.Protocol, facts); !compatible {
		a.queue.AbortPrint(jobID, "payload_incompatible")
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: %s", why)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}

	if a.queue.IsProcessed(jobID) {
		log.Printf("Job %s was already processed while waiting for dispatch. Skipping.", jobID)
		return
	}

	// The printer fence above remains held through physical dispatch. Only the
	// physical execution phase consumes a global worker slot, so same-printer
	// waiters do not starve unrelated printers.
	select {
	case a.execSem <- struct{}{}:
		defer func() { <-a.execSem }()
	case <-ctx.Done():
		// BeginPrint already persisted `printing`, but no physical execution
		// slot was acquired, so zero hardware bytes can have been sent. Roll the
		// local attempt back before returning the claim to Gateway; otherwise a
		// later same-token redelivery could reopen the stale `printing` row and
		// dispatch the physical side effect twice.
		if err := a.queue.AbortPrint(jobID, "dispatch_refused: agent shutting down before physical execution slot; zero bytes transmitted"); err != nil {
			log.Printf("Job %s: failed to abort local ledger after execution-slot cancellation: %v", jobID, err)
		}
		a.rejectJob(ctx, jobID, claimToken, "agent_shutting_down")
		return
	}

	reportStart := time.Now()
	if err := a.updateJobStatus(ctx, jobID, "printing", "", claimToken, ""); err != nil {
		// Context cancellation is an authoritative local lifecycle signal, not
		// a generic gateway transport failure. Never use the stale-claim
		// freshness heuristic to proceed to hardware after shutdown/session
		// cancellation.
		if ctx.Err() != nil {
			log.Printf("Job %s: printing report cancelled by agent lifecycle; aborting before hardware", jobID)
			if aberr := a.queue.AbortPrint(jobID, "dispatch_refused: agent context cancelled before physical dispatch; zero bytes transmitted"); aberr != nil {
				log.Printf("Job %s: failed to abort local ledger row: %v", jobID, aberr)
			}
			return
		}
		if proceed, reason := a.authorizeDispatchAfterReportFailure(jobID, err); !proceed {
			log.Printf("Job %s: physical dispatch refused (%s); aborting before any byte is sent", jobID, reason)
			if aberr := a.queue.AbortPrint(jobID, "dispatch_refused: "+reason+"; zero bytes transmitted"); aberr != nil {
				log.Printf("Job %s: failed to abort local ledger row: %v", jobID, aberr)
			}
			return
		}
	}
	log.Printf("print.trace printing_report request_id=%s job_id=%s printer_id=%s report_latency_ms=%d", requestID, jobID, printerID, time.Since(reportStart).Milliseconds())

	// Only the physical execution phase gets a document-specific timeout.
	printCtx, cancel := context.WithTimeout(ctx, printDocumentTimeout(len(pl.Data)))
	defer cancel()
	printCtx = printer.WithDispatchAdmission(printCtx, func(admissionCtx context.Context) error {
		if a.fencedForDispatch() || !a.isPrinterExecutionAllowed(localPrinterID) {
			return fmt.Errorf("dispatch refused: agent or printer configuration changed before this transport submission")
		}
		if err := a.updateJobStatus(admissionCtx, jobID, "printing", "", claimToken, ""); err != nil {
			return fmt.Errorf("dispatch refused after preparation: %w", err)
		}
		return nil
	})

	if a.queue.IsProcessed(jobID) {
		log.Printf("Job %s was already processed while waiting for printer %s. Skipping duplicate print.", jobID, printerID)
		return
	}
	if ctx.Err() != nil {
		a.queue.AbortPrint(jobID, "dispatch_refused: agent context cancelled before physical print; zero bytes transmitted")
		return
	}
	// Kind-aware dispatch: PDF goes through the PDF pipeline (validated,
	// written to a secure temp file, rendered by the printer driver), raw and
	// ESC/POS keep their byte-stream paths. A PDF is never re-labelled as RAW.
	printData := pl.Data
	physicalPeripheralSideEffect := false
	hasActivePeripherals := (pl.Peripherals.Drawer != "" && pl.Peripherals.Drawer != "none") ||
		(pl.Peripherals.Cutter != "" && pl.Peripherals.Cutter != "none") ||
		(pl.Peripherals.Buzzer != "" && pl.Peripherals.Buzzer != "none")
	if hasActivePeripherals {
		profile := printer.PeripheralProfile{
			DrawerKickMode: pl.Peripherals.Drawer,
			CutterMode:     pl.Peripherals.Cutter,
			BuzzerMode:     pl.Peripherals.Buzzer,
		}
		// Insert a 150ms delay between cash drawer solenoid triggers and thermal print heads
		// to prevent microcontroller brownouts on 24V power adapters.
		if (pl.Peripherals.Drawer == "pin2" || pl.Peripherals.Drawer == "pin5") && strings.ToLower(strings.TrimSpace(pl.Protocol)) == "escpos" {
			drawerCmd := printer.DrawerKickPin2
			if pl.Peripherals.Drawer == "pin5" {
				drawerCmd = printer.DrawerKickPin5
			}
			drawerErr := p.Print(printCtx, drawerCmd)
			if drawerErr != nil {
				log.Printf("print.trace peripheral_drawer_kick_failed request_id=%s job_id=%s printer_id=%s error=%v", requestID, jobID, printerID, drawerErr)
				// The drawer kick is an independent physical side effect. A proven
				// pre-dispatch failure is retryable, but an ambiguous failure must
				// poison the attempt as UNKNOWN so it can never be silently retried.
				if printer.OutcomeUnknown(drawerErr) {
					reason := "UNKNOWN_PARTIAL_DELIVERY: cash-drawer kick outcome is ambiguous; automatic retry is unsafe: " + drawerErr.Error()
					a.queue.UpdateStatusWithError(jobID, "failed", reason)
					a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
					return
				}
				a.queue.UpdateStatusWithError(jobID, "failed", drawerErr.Error())
				a.updateJobStatus(ctx, jobID, "failed", drawerErr.Error(), claimToken, "")
				return
			}
			// A successful drawer kick is already a physical side effect. Any
			// later ambiguity must therefore remain UNKNOWN even when the main
			// print stream itself has not started yet.
			physicalPeripheralSideEffect = true
			select {
			case <-printCtx.Done():
				reason := "UNKNOWN_PARTIAL_DELIVERY: cash-drawer kick succeeded but the print attempt was cancelled before the main document dispatch"
				a.queue.UpdateStatusWithError(jobID, "failed", reason)
				a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
				return
			case <-time.After(150 * time.Millisecond):
			}
			profile.DrawerKickMode = "none"
		}
		printData = printer.WrapPeripheralCommands(printData, pl.Protocol, profile)
	}
	printStart := time.Now()
	log.Printf("print.trace render_transport_start request_id=%s job_id=%s printer_id=%s local_execution_ms=%d payload_bytes=%d kind=%s", requestID, jobID, printerID, time.Since(receivedAt).Milliseconds(), len(printData), kind)
	// Persist platform submission evidence DURING the printing phase, not
	// only with the terminal result: a crash between StartDoc (identity
	// allocated) and the terminal ledger write must not lose the only
	// durable link to the platform job. The observer stops when dispatch
	// returns; the terminal path remains authoritative.
	stopSpoolWatch := a.watchSpoolerJobID(jobID, p)
	printErr := printer.PrintDocument(printCtx, p, printer.Document{Kind: kind, Data: printData, JobID: jobID})
	stopSpoolWatch()
	log.Printf("print.trace transport_complete request_id=%s job_id=%s printer_id=%s transport_latency_ms=%d success=%t", requestID, jobID, printerID, time.Since(printStart).Milliseconds(), printErr == nil)

	// Capture platform submission evidence for this attempt regardless of the
	// terminal result. Windows can allocate a spool job before a later write or
	// render error, and that identity is essential for safe reconciliation.
	spoolerJobID := printer.SpoolerJobIDOf(p)
	failureMsg := ""
	if printErr != nil {
		failureMsg = printErr.Error()
		// Belt and braces: if the transport chain proved an ambiguous
		// physical outcome but lost the marker through wrapping, restore it
		// here so the gateway can NEVER classify this as safely retryable.
		if printer.OutcomeUnknown(printErr) && !printer.HasUnknownOutcomeMarker(failureMsg) {
			failureMsg = "UNKNOWN_PARTIAL_DELIVERY: " + failureMsg
		}
		if physicalPeripheralSideEffect && !printer.HasUnknownOutcomeMarker(failureMsg) {
			failureMsg = "UNKNOWN_PARTIAL_DELIVERY: peripheral side effect succeeded before main print outcome was known: " + failureMsg
		}
		if err := a.queue.UpdateTerminalWithEvidence(jobID, "failed", failureMsg, spoolerJobID); err != nil {
			log.Printf("Job %s: ledger write failed after print failure: %v", jobID, err)
			// Physical execution already happened (or is ambiguous). If the
			// durable terminal row cannot be written, keep an in-process fence
			// including any platform identity so duplicate delivery cannot
			// execute the printer again and later reconciliation keeps its evidence.
			a.rememberTerminalExecution(jobID, "failed", failureMsg, claimToken, spoolerJobID)
		}
	} else {
		if err := a.queue.UpdateTerminalWithEvidence(jobID, "success", "", spoolerJobID); err != nil {
			// Physical execution already succeeded. If SQLite cannot persist
			// the terminal row, keep an in-process fence INCLUDING the platform
			// job identity so a lost Gateway acknowledgement can be re-reported
			// without executing the printer again. On restart, a durable row that
			// remained `printing` is converted to an explicit unknown outcome.
			log.Printf("Job %s: ledger write failed after successful print: %v", jobID, err)
			a.rememberTerminalExecution(jobID, "success", "", claimToken, spoolerJobID)
		}
	}

	if printErr != nil {
		log.Printf("Job %s FAILED on printer %s: %v", jobID, printerID, printErr)
		a.updateJobStatus(ctx, jobID, "failed", failureMsg, claimToken, printer.SpoolerJobIDOf(p))
		return
	}

	log.Printf("Job %s: payload transmitted successfully to printer %s", jobID, printerID)
	// Surface the platform job identity (Windows spooler) when the backend
	// reports one. SpoolerJobIDOf returns "" for every other backend, so
	// this stays a no-op off Windows and the Gateway contract is unchanged.
	a.updateJobStatus(ctx, jobID, "success", "", claimToken, spoolerJobID)
}

// watchSpoolerJobID persists platform submission evidence observed while
// hardware dispatch runs. It polls the backend's reported identity and
// records the first non-empty value into the printing ledger row, then
// stops when dispatch returns (the returned closure blocks until the
// observer exits, so no write races the terminal update). Failures are
// best-effort by design: the terminal path re-captures the identity and
// stays authoritative. Non-reporting backends yield "" forever and cost one
// woken poll per dispatch.
func (a *Agent) watchSpoolerJobID(jobID string, p printer.Printer) (stop func()) {
	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		record := func() bool {
			if id := printer.SpoolerJobIDOf(p); id != "" {
				// Log failures for diagnostics but keep watching: a
				// transient SQLite error must not lose later evidence,
				// and the final stop-time read gets one more chance.
				if err := a.queue.RecordSpoolerJobID(jobID, id); err != nil {
					log.Printf("Job %s: mid-phase spooler identity persist failed: %v", jobID, err)
				}
				return true
			}
			return false
		}
		for {
			select {
			case <-stopCh:
				record()
				return
			case <-ticker.C:
				if record() {
					// Identity is stable for the attempt; further polls
					// only repeat the same write. Keep watching cheaply:
					// a backend could theoretically reallocate, and the
					// stop-time read covers the common case anyway.
				}
			}
		}
	}()
	return func() {
		close(stopCh)
		<-done
	}
}

// ErrStaleClaim is returned by updateJobStatus when the gateway rejects a
// status report at the claim fence (HTTP 409/410 or a STALE_CLAIM /
// FENCE_REJECTED payload): this attempt no longer owns the job. processJob
// treats it as a HARD STOP before any byte reaches the printer.
var ErrStaleClaim = errors.New("gateway rejected claim fence: stale or reclaimed token")

// ErrTransitionRejected is returned by updateJobStatus when the gateway
// answers a status report with an explicit non-fence rejection (any other
// 4xx/5xx). Unlike a transport error, this IS authoritative: the gateway
// evaluated our transition and refused it, so physical dispatch must stop.
var ErrTransitionRejected = errors.New("gateway rejected status transition")

func (a *Agent) updateJobStatus(ctx context.Context, jobID, status, errMsg, claimToken, spoolerJobID string, reason ...string) error {
	// The caller owns this immutable attempt token; never substitute a newer delivery.
	reqURL := "/api/agent/jobs"
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": status,
		"error":  errMsg,
	}
	if claimToken != "" {
		body["claimToken"] = claimToken
	}
	// Spooler evidence is additive and optional: older Gateway versions
	// ignore unknown fields, and printers without a platform identity
	// (network/USB/IPP, non-Windows stub) report "" and omit it.
	if spoolerJobID != "" {
		body["spoolerJobId"] = spoolerJobID
	}
	if len(reason) > 0 && reason[0] != "" {
		body["reason"] = reason[0]
	}
	resp, err := a.doAuthorizedRequest(ctx, "PATCH", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report status %q to server: %v", jobID, status, err)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Job %s: failed to read status rejection body: %v", jobID, readErr)
		}
		log.Printf("Job %s: server rejected status update to %q (%d): %s", jobID, status, resp.StatusCode, string(respBody))
		// Fence rejection: the gateway no longer recognizes this claim
		// (expired and reassigned, or never valid). Callers MUST treat this
		// as authoritative - especially the claimed->printing transition,
		// which must never proceed to hardware afterwards.
		if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusGone ||
			strings.Contains(string(respBody), "STALE_CLAIM") || strings.Contains(string(respBody), "FENCE_REJECTED") {
			return fmt.Errorf("%w: job %s status %q rejected (%d)", ErrStaleClaim, jobID, status, resp.StatusCode)
		}
		return fmt.Errorf("%w to %q (%d): %s", ErrTransitionRejected, status, resp.StatusCode, string(respBody))
	}
	if status == "printing" || status == "success" || status == "failed" {
		var accepted struct {
			Success bool   `json:"success"`
			Status  string `json:"status"`
		}
		ackBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes+1))
		if readErr != nil || len(ackBody) > maxGatewayErrorBodyBytes {
			return fmt.Errorf("%w: unreadable or oversized status acknowledgement", ErrTransitionRejected)
		}
		if err := json.Unmarshal(ackBody, &accepted); err != nil {
			return fmt.Errorf("%w: invalid status acknowledgement: %v", ErrTransitionRejected, err)
		}
		if !accepted.Success || accepted.Status != status {
			return fmt.Errorf("%w: Gateway did not acknowledge %q (status %q)", ErrTransitionRejected, status, accepted.Status)
		}
	}
	if status == "success" || status == "failed" {
		if err := a.queue.ClearClaimToken(jobID, claimToken); err != nil {
			// The Gateway already acknowledged the terminal outcome; retain the
			// local token if SQLite cleanup fails so a later scan can retry the
			// harmless cleanup without reprinting.
			log.Printf("Job %s: Gateway acknowledged terminal status %q but local report token cleanup failed: %v", jobID, status, err)
		}
	}
	return nil
}

func (a *Agent) doAuthorizedRequest(ctx context.Context, method, endpointPath string, body interface{}) (*http.Response, error) {
	target, err := config.GatewayEndpoint(a.cfg.Server.URL, endpointPath)
	if err != nil {
		return nil, fmt.Errorf("invalid Gateway endpoint: %w", err)
	}
	var buf io.Reader
	if body != nil {
		b := new(bytes.Buffer)
		if err := json.NewEncoder(b).Encode(body); err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		buf = b
	}

	req, err := http.NewRequestWithContext(ctx, method, target, buf)
	if err != nil {
		return nil, err
	}

	// Never log this header - it contains the agent credential.
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}

	// Callers own resp.Body: they read it and close it (usually via
	// defer resp.Body.Close()). A previous version drained+closed the body
	// here in a background goroutine while callers were still reading it,
	// which raced (read on closed body, truncated heartbeat/job payloads).
	// Do NOT touch resp.Body here; connection reuse is handled by callers
	// closing the body after a full read.

	if resp.StatusCode == http.StatusUnauthorized {
		log.Printf("CRITICAL: Agent %s unauthorized by server. Credentials may have been revoked; re-pair this agent.", a.cfg.Agent.ID)
	}

	return resp, nil
}
