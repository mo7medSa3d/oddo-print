package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/license"
	"github.com/yaseir-agent/agent/internal/payload"
	"github.com/yaseir-agent/agent/internal/printer"
	"github.com/yaseir-agent/agent/internal/queue"
)

// Job concurrency limits. Physical printing is serialized per printer, but
// without an upper bound on in-flight jobs an Odoo-side burst (e.g. a large
// offline backlog delivered after a reconnect) would spawn one goroutine per
// job and exhaust memory on a small POS terminal.
//
// maxConcurrentJobs — jobs actually executing (HTTP status calls, printing)
// maxPendingJobs    — jobs accepted into the local executor, including ones
//
//	waiting for an execution slot; overflows are dropped
//	and naturally re-delivered by Odoo after the
//	claim lease expires (see src/app/api/agent/jobs).
const (
	maxConcurrentJobs        = 8
	maxPendingJobs           = 64
	maxPendingJobsPerPrinter = 8
	// HTTP acknowledgement work is bounded. Odoo claim leases
	// remains the final recovery mechanism if these best-effort queues fill.
	maxRejectQueue         = 32
	maxTerminalReportQueue = 32
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
//     page. Legacy odoos can return a larger complete snapshot; the
//     collector still enforces the local metadata budget before applying it.
const (
	maxGatewayErrorBodyBytes = 8 << 10
	maxClaimBatch            = 20
	// Heartbeat is control-plane metadata only. Keep a hard multi-megabyte
	// ceiling for legacy responses. Current Gateway pages are much smaller;
	// a bounded cap prevents a malformed odoo from consuming hundreds of MiB.
	maxHeartbeatBytes            = 32 << 20
	maxHeartbeatProbeConcurrency = 64
)

func maxPollJobsBytes() int64 {
	return int64(maxClaimBatch) * int64(payload.MaxPayloadBytes)
}

// pollJobsByteLimit is the live poll-response ceiling: the decoded-bytes
// batch product above (20 x 5 MiB = 100 MiB). The odoo additionally
// trims every poll response to MAX_POLL_RESPONSE_BYTES = 64 MiB of ENCODED
// wire bytes (src/app/api/agent/jobs/route.ts), so this reader always has
// headroom against current Gateways: the twenty-maximum-size-jobs framing
// at ~140 MiB encoded (which would fail the whole batch decode while
// their claims stayed delivery-pending) cannot occur once the Gateway
// trim applies. The 100 MiB ceiling remains as defense-in-depth for a
// non-trimming Gateway.
// It defaults to the documented batch product and is only varied by tests
// in this package (which run sequentially), so a bounded read can be
// exercised without transferring the full production ceiling.
var pollJobsByteLimit = maxPollJobsBytes()

// shutdownGrace bounds how long Run waits for in-flight jobs after the agent
// is asked to stop. The Windows SCM default stop timeout is 30s.
const shutdownGrace = 25 * time.Second

// Gateway control-plane transport. Carries Bearer id:secret and print
// payloads, so it must not inherit HTTP_PROXY/HTTPS_PROXY from the
// environment by default (mirrors printer/ipp.go ippDirectTransport).
// Proxy-required egress networks opt in explicitly with
// YASEIR_AGENT_ALLOW_PROXY=1, mirroring the YASEIR_AGENT_ALLOW_INSECURE_HTTP
// opt-in convention in internal/config.
func odooProxyEnabled() bool {
	return os.Getenv("YASEIR_AGENT_ALLOW_PROXY") == "1"
}

func odooProxyFunc(req *http.Request) (*url.URL, error) {
	if odooProxyEnabled() {
		return http.ProxyFromEnvironment(req)
	}
	return nil, nil
}

var odooDirectTransport = &http.Transport{
	Proxy:               odooProxyFunc,
	DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 20 * time.Second}).DialContext,
	TLSHandshakeTimeout: 5 * time.Second,
	MaxIdleConns:        32,
	MaxIdleConnsPerHost: 4,
	IdleConnTimeout:     30 * time.Second,
}

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
const maxResponseDrainBytes = 64 * 1024

// drainAndCloseBody drains a bounded unread tail before closing resp.Body so
// net/http can return keep-alive TCP connections to the idle pool without
// risking unbounded reads from a misbehaving server.
func drainAndCloseBody(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, maxResponseDrainBytes))
	_ = body.Close()
}

// jitteredBackoff adds bounded positive jitter (+0..25%) so a fleet of POS
// terminals backing off after an Odoo restart or 5xx/429 does not reconnect
// in lockstep while preserving minimum Retry-After / fence floors.
func jitteredBackoff(base time.Duration) time.Duration {
	spread := base / 4
	if spread <= 0 {
		return base
	}
	return base + time.Duration(rand.Int64N(int64(spread)))
}

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

// terminalReportWork only re-reports a known physical outcome. The claim token
// is captured from the *original physical attempt*, never from a duplicate
// delivery. A later Gateway claim cannot authorize the old attempt's report.
type terminalReportWork struct {
	ctx    context.Context
	jobID  string
	result terminalExecutionResult
	key    string
}

type Agent struct {
	cfg          *config.Config
	configPath   string
	registryPath string
	client       *http.Client
	// printersMu protects printers and printerConfigs: the async discovery
	// goroutine and Discover/RegisterManual mutate them while heartbeat
	// payloads and job dispatch read them concurrently.
	printersMu           sync.RWMutex
	printers             map[string]printer.Printer
	printerConfigs       map[string]config.PrinterConfig
	printerAliases       map[string]string
	odooDisabledPrinters map[string]struct{}
	// retiredPrinters is not executable inventory. It retains the exact old
	// backend after disable/removal until its detached native worker exits.
	// Losing this reference would let re-enable install an independent mutex
	// while the old worker can still submit bytes. Protected by printersMu.
	retiredPrinters map[string]printer.Printer
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
	// so the odoo can fence the lease refresh to the live claim.
	inFlightTokens map[string]string
	// pendingByPrinter bounds waiting goroutines for a single printer so one
	// slow/unreachable device cannot consume the entire global pending budget.
	pendingByPrinter map[string]int
	inFlightPrinters map[string]string
	// inFlightReceived records when each delivery was accepted, under the
	// same mutex. It bounds the physical-dispatch race: the odoo sweep
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
	// printers probing at 2s, slow odoo) must never let ticks pile up.
	hbMu        sync.Mutex
	pollMu      sync.Mutex
	pollPending atomic.Bool
	// heartbeatTrigger carries out-of-cycle heartbeat requests (spooler changes
	// and completed local discovery).
	// to the Run loop. Buffered 1 and written non-blockingly: a pending
	// request already means "send a full snapshot as soon as possible",
	// and every heartbeat is a complete inventory snapshot, so coalescing
	// duplicate requests loses nothing.
	heartbeatTrigger    chan struct{}
	wsWakeCh            chan struct{}
	wsConnected         atomic.Bool
	licenseGuard        *license.RuntimeGuard
	lastVisibilityStamp string
	// observations caches the heartbeat probe loop's per-printer geometry
	// measurements and verification outcomes. Dispatch reads it for
	// last-known geometry and advisory verification state; it is written
	// only by completed probe cycles.
	observations *observationCache
	// spoolerRefreshMu makes change-notification rescans non-reentrant,
	// and spoolerRefreshLast debounces notification bursts (one printer
	// install can raise many change events in a second).
	spoolerRefreshMu   sync.Mutex
	spoolerRefreshLast atomic.Int64 // unix nanos
	// spoolerRefreshPending records that a change event arrived while a
	// rescan was already running or inside the debounce window, so a
	// trailing rescan is owed; spoolerRefreshTimerArmed ensures at most
	// one trailing-rescan timer is outstanding.
	spoolerRefreshPending    atomic.Bool
	spoolerRefreshTimerArmed atomic.Bool
	// terminalReportMu prevents concurrent terminal-status reporting goroutines.
	terminalReportMu sync.Mutex
	// Guarded by terminalReportMu. Advance across rejected original claims
	// without deleting evidence; wrap to retry them after the complete scan.
	terminalReportAfterID   string
	terminalReportThroughID string
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
	billingBlocked        atomic.Bool

	// discoverySem bounds concurrent odoo-directed discovery sessions to
	// one: each session is a full bounded LAN scan (30s bound), and piling
	// them up per pending session (as an unbounded go-per-session did)
	// would fork a scan per session. Pending sessions expire on the
	// odoo in 60s, so the next poll tick simply picks the rest up.
	discoverySem chan struct{}
	// discoveryGen fences semaphore ownership across force-releases: a scan
	// wedged in uncancellable OS I/O holds its slot until the watchdog
	// recycles it, and the late finisher must not release another scan's
	// slot afterwards. discoveryWedged stays true once set so the wedged
	// scan is visible in diagnostics until process restart.
	//
	// discoveryAbandoned counts scans whose worker was left blocked in
	// uncancellable OS I/O. Each one leaks a goroutine for the lifetime of
	// the process, so the watchdog stops force-recycling the semaphore once
	// the cap is reached.
	discoveryGen       atomic.Uint64
	discoveryWedged    atomic.Bool
	discoveryAbandoned atomic.Int32

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
	// runtimeActive permits a bounded drain without spawning a WaitGroup
	// waiter that would itself survive a wedged native/control-plane call.
	// A task retains ownership until all its tracked children are registered.
	runtimeActive atomic.Int64

	// rejectQueue is the bounded hand-back path used by the WS reader when
	// local admission is saturated. The reader never performs the HTTP PATCH
	// itself. Each work item carries the connection/session context so a closed
	// The worker cancels stale rejection work before it can mutate Odoo state.
	rejectQueue   chan rejectWork
	rejectMu      sync.Mutex
	rejectPending map[string]struct{}
	// Separate bounded I/O path for a duplicate of an already physically
	// completed job whose SQLite terminal write failed. The worker
	// must not perform HTTP status reporting, including response-body reads.
	terminalReportQueue   chan terminalReportWork
	terminalReportPending map[string]struct{}
	terminalReportQueueMu sync.Mutex

	// Single-flight probe state per printer: prevents unbounded goroutine accumulation
	// when Win32 Spooler or network RPC calls block.
	probeStateMu sync.Mutex
	probeStates  map[string]*printerProbeState
}

type terminalExecutionResult struct {
	status       string
	errMsg       string
	claimToken   string
	spoolerJobID string
	transport    string
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

func (a *Agent) recordPrinterProbeResult(printerID string, probedConfig config.PrinterConfig, backend printer.Printer, status string) bool {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	current, present := a.printerConfigs[printerID]
	if !present || a.printers[printerID] != backend || !sameConfigWithoutObservedIPPUUID(current, probedConfig) {
		return false
	}
	if prev := a.probeLastStatus(printerID); prev != status {
		log.Printf("[printer] %s (%s) status %s -> %s", probedConfig.Name, printerID, prev, status)
	}
	a.setProbeLastStatus(printerID, status)
	return true
}

// observeDesiredRevision requires a real backend observation, independent of
// physical readiness. Instantiating configured transport alone is not evidence.
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

// retiredSessionMayBeLiveLocked keeps lifecycle retirement separate from native
// completion. The caller holds printersMu; no timeout or desired revision is
// evidence that a detached worker has stopped owning its physical transport.
func (a *Agent) retiredSessionMayBeLiveLocked(id string) bool {
	if priorSessionMayBeLive(a.retiredPrinters[id]) {
		return true
	}
	delete(a.retiredPrinters, id)
	return false
}

// retirePrinterLocked removes executable inventory without dropping a live
// generation. Callers hold both the per-printer execution lock and printersMu.
// Repeated removal must not overwrite a still-live retired backend with nil.
func (a *Agent) retirePrinterLocked(id string) {
	if priorSessionMayBeLive(a.printers[id]) {
		if a.retiredPrinters == nil {
			a.retiredPrinters = make(map[string]printer.Printer)
		}
		a.retiredPrinters[id] = a.printers[id]
	}
	delete(a.printers, id)
	delete(a.printerConfigs, id)
	a.retiredSessionMayBeLiveLocked(id)
}

// reapRetiredPrintersLocked bounds retained references to genuinely live
// workers. It runs on reconciliation, never by expiring a safety fence.
func (a *Agent) reapRetiredPrintersLocked() {
	for id := range a.retiredPrinters {
		a.retiredSessionMayBeLiveLocked(id)
	}
}

func (a *Agent) addPrinter(id string, p printer.Printer, pc config.PrinterConfig) bool {
	if !pc.IsEnabled() || a.legacyPrinterDisabled(id) {
		return false
	}
	lock := a.getPrinterLock(id)
	if !lockPrinterUntil(lock, a.shutdownCh) {
		return false
	}
	defer lock.Unlock()
	a.printersMu.Lock()
	defer a.printersMu.Unlock()
	if a.retiredSessionMayBeLiveLocked(id) {
		log.Printf("printer %q registration deferred: a retired print session may still own the transport", id)
		return false
	}
	if old, exists := a.printerConfigs[id]; exists {
		if identity := printer.VerifiedIPPUUIDFromCapabilities(old.Capabilities); identity != "" && identity != printer.VerifiedIPPUUIDFromCapabilities(pc.Capabilities) {
			log.Printf("printer %q rediscovery conflicts with its verified IPP identity; retaining established runtime", id)
			return false
		}
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
	a.attachPrinterIdentityPersistence(p, pc)
	a.printers[id] = p
	a.printerConfigs[id] = pc
	a.setProbeLastStatus(id, "unknown")
	return true
}

func (a *Agent) getPrinter(id string) (printer.Printer, bool) {
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	p, ok := a.printers[id]
	return p, ok
}

// odooAliasPrinterID must match src/lib/printer-identity.ts exactly.
// Keep the suffix unchanged for already issued aliases, and truncate only
// on complete UTF-8 rune boundaries so long local identifiers fit the
// Gateway's 120-byte printer ID limit.
func odooAliasPrinterID(localID, agentID string) string {
	sum := sha256.Sum256([]byte("printer-alias:" + agentID + ":" + localID))
	prefix := localID
	if len(prefix) > 111 {
		prefix = prefix[:111]
		for !utf8.ValidString(prefix) {
			prefix = prefix[:len(prefix)-1]
		}
	}
	return fmt.Sprintf("%s~%x", prefix, sum[:4])
}

// resolvePrinterAlias checks BOTH the agent identity and the complete local
// ID hash before selecting an execution backend. Stripping an arbitrary
// 8-hex suffix used to let a forged alias choose any matching local printer;
// and a 120-byte local ID would create an unreportable 129-byte cloud ID.
// Exact local IDs still win; ambiguous hash matches fail closed.
func (a *Agent) resolvePrinterAlias(printerID string) string {
	i := strings.LastIndexByte(printerID, '~')
	if i <= 0 || len(printerID)-i-1 != 8 {
		return printerID
	}
	suffix := printerID[i+1:]
	for j := 0; j < len(suffix); j++ {
		c := suffix[j]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return printerID
		}
	}
	prefix := printerID[:i]
	a.printersMu.RLock()
	defer a.printersMu.RUnlock()
	_, exact := a.printers[printerID]
	matched := ""
	for localID := range a.printers {
		if localID == printerID || !strings.HasPrefix(localID, prefix) ||
			odooAliasPrinterID(localID, a.cfg.Agent.ID) != printerID {
			continue
		}
		if exact || matched != "" {
			return "" // ambiguous backend: all physical dispatch gates deny it
		}
		matched = localID
	}
	if exact {
		return printerID
	}
	if matched != "" {
		return matched
	}
	if !exact {
		if mapped, ok := a.printerAliases[printerID]; ok && mapped != "" {
			if _, exists := a.printers[mapped]; exists {
				return mapped
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

func (a *Agent) sharedPrinterCount() int {
	a.printersMu.RLock()
	ids := make([]string, 0, len(a.printers))
	for id := range a.printers {
		ids = append(ids, id)
	}
	a.printersMu.RUnlock()
	count := 0
	for _, id := range ids {
		if a.isPrinterAvailableToOdoo(id) {
			count++
		}
	}
	return count
}

func printerConfigFromDeviceInfo(di printer.DeviceInfo) config.PrinterConfig {
	// Single authority mapping a discovered/manual DeviceInfo onto the
	// backend PrinterConfig. Every field the USB backend needs (VID/PID/
	// serial) and everything the heartbeat reports (capabilities, class)
	// must survive this translation; dropping fields here silently
	// degrades direct-USB printers to VID 0/PID 0.
	enabled := di.Enabled
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
		Enabled:      &enabled,
	}
}

func (a *Agent) mergeDiscoveredPrinter(di printer.DeviceInfo) (bool, error) {
	pc := printerConfigFromDeviceInfo(di)
	pc, err := a.resolveLocalPrinter(pc)
	if err != nil {
		return false, err
	}
	a.printersMu.RLock()
	prior, exists := a.printerConfigs[di.ID]
	a.printersMu.RUnlock()
	if exists {
		known := printer.VerifiedIPPUUIDFromCapabilities(prior.Capabilities)
		incoming := printer.VerifiedIPPUUIDFromCapabilities(pc.Capabilities)
		if known != "" && incoming != "" && known != incoming {
			return false, fmt.Errorf("verified IPP printer identity changed; explicitly reconcile registration")
		}
		if known != "" && incoming == "" {
			caps := make(map[string]interface{}, len(pc.Capabilities)+1)
			for key, value := range pc.Capabilities {
				caps[key] = value
			}
			caps["ipp_printer_uuid"] = known
			pc.Capabilities = caps
		}
	}
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
	registryPath := config.RegistryPath(configPath)
	// Saved printer authority must be readable before configured or discovered
	// backends are admitted. An absent file is the normal first-install state;
	// an unreadable existing file requires explicit repair and is left intact.
	// Check before opening the durable queue so failed recovery cannot alter it.
	registered, err := printer.LoadRegistryPrinters(registryPath)
	if err != nil {
		return nil, fmt.Errorf("load saved printer authority: %w", err)
	}
	disabled := printer.NewLocalPrinterDisablement(cfg, registered)
	dbPath := config.QueueDBPath(configPath)
	licGuard, err := license.NewRuntimeGuardFromConfig(filepath.Dir(dbPath))
	if err != nil {
		return nil, fmt.Errorf("initialize license guard: %w", err)
	}
	if err := licGuard.ApplyBundleFromEnv(); err != nil {
		return nil, fmt.Errorf("apply offline license bundle: %w", err)
	}
	q, err := queue.New(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open local queue at %s: %w", dbPath, err)
	}

	a := &Agent{
		cfg:          cfg,
		configPath:   configPath,
		registryPath: registryPath,
		// Never follow redirects with the credential-bearing client: a 3xx
		// from the odoo/proxy would otherwise forward
		// `Authorization: Bearer id:secret` to the redirect target.
		// Callers treat 3xx as an error and surface it.
		client: &http.Client{Transport: odooDirectTransport, Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		printers:              make(map[string]printer.Printer),
		printerConfigs:        make(map[string]config.PrinterConfig),
		printerAliases:        make(map[string]string),
		heartbeatTrigger:      make(chan struct{}, 1),
		wsWakeCh:              make(chan struct{}, 1),
		licenseGuard:          licGuard,
		observations:          newObservationCache(),
		registryOwned:         make(map[string]struct{}),
		queue:                 q,
		execSem:               make(chan struct{}, maxConcurrentJobs),
		pendingSlots:          make(chan struct{}, maxPendingJobs),
		inFlight:              make(map[string]struct{}),
		inFlightTokens:        make(map[string]string),
		pendingByPrinter:      make(map[string]int),
		inFlightPrinters:      make(map[string]string),
		inFlightReceived:      make(map[string]time.Time),
		terminalExecution:     make(map[string]terminalExecutionResult),
		shutdownCh:            make(chan struct{}),
		discoverySem:          make(chan struct{}, 1),
		rejectQueue:           make(chan rejectWork, maxRejectQueue),
		rejectPending:         make(map[string]struct{}),
		terminalReportQueue:   make(chan terminalReportWork, maxTerminalReportQueue),
		terminalReportPending: make(map[string]struct{}),
	}

	// 1. Load configured printers from YAML (legacy, still supported for backward compat)
	for _, pc := range cfg.Printers {
		if !pc.IsEnabled() {
			continue
		}
		pc, err := a.resolveLocalPrinter(pc)
		if err != nil {
			log.Printf("WARNING: printer %q local output profile is unavailable", pc.ID)
			continue
		}
		if disabled.Disabled(pc) {
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
	quick.Printers = printer.RuntimeInventoryPrinters(quick.Printers)
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

// A failed new write retains observations with a diagnostic. An unreadable
// saved registry is different: prior operator authority cannot be reconstructed
// from a fresh observation, so it cannot become a runtime fallback.
func (a *Agent) persistDiscoveredPrinters(infos []printer.DeviceInfo) ([]printer.DeviceInfo, error) {
	merged, err := printer.UpsertRegistry(a.registryPath, infos)
	if err == nil {
		// UpsertRegistry merges the current observations with historical rows.
		// Re-apply the runtime-capability filter so an old candidate-only LPR
		// row cannot re-enter the production inventory after a newer scan.
		return printer.RuntimeInventoryPrinters(merged), nil
	}
	if errors.Is(err, printer.ErrRegistryUntrusted) {
		log.Printf("WARNING: discovery admission blocked by unreadable saved printer authority: %v", err)
		return nil, err
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
	infos := printer.RuntimeInventoryPrinters(result.Printers)
	merged, err := printer.ReconcileDiscoveryRegistry(a.registryPath, infos, result.CompleteSources)
	if err == nil {
		return printer.RuntimeInventoryPrinters(merged), nil
	}
	if errors.Is(err, printer.ErrRegistryUntrusted) {
		log.Printf("WARNING: live discovery admission blocked by unreadable saved printer authority: %v", err)
		return nil, err
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
	return printer.RuntimeInventoryPrinters(infos)
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

	// Small delay to let odoo communication start first
	delay := time.NewTimer(2 * time.Second)
	select {
	case <-ctx.Done():
		delay.Stop()
		return
	case <-delay.C:
	}

	a.runInitialDiscovery(ctx, defaultDiscoveryTimeout, func(scanCtx context.Context, onProgress printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		return printer.DiscoverLiveWithProgress(scanCtx, a.cfg, a.registryPath, onProgress)
	})
}

// runInitialDiscovery owns the startup scan independently of the delay which
// lets Gateway communication start first. The scan boundary may contain a
// synchronous native call which outlives its context.
func (a *Agent) runInitialDiscovery(ctx context.Context, timeout time.Duration, discover discoveryScanFunc) {
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
	full, completed, finishedCh := runBoundedDiscovery(ctx, timeout, discover)
	if !completed || full.Truncated {
		// A synchronous Win32 call can outlive its Go context. Keep the semaphore
		// owned until that worker actually returns, but do not attach this waiter
		// to runtimeWG: graceful shutdown must not wait forever on OS RPC. A
		// usable partial result does not mean that its native worker finished.
		releaseSemaphore = false
		a.releaseDiscoverySemaphoreWhenFinished(finishedCh)
	}
	if !completed {
		log.Printf("[discovery] async full discovery exceeded %s bound; worker may still be finishing", timeout)
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
		// Publish the refreshed inventory now, not at the next tick.
		a.requestImmediateHeartbeat()
	}

	log.Printf("[discovery] async discovery completed: %d live observations, %d durable runtime printers", len(full.Printers), len(merged))
}

// RegisterManual adds a manually configured printer (for when discovery cannot identify correctly).
func (a *Agent) RegisterManual(info printer.DeviceInfo) error {
	if info.ID != "" {
		if _, exists := a.getPrinter(info.ID); exists {
			return fmt.Errorf("printer ID %q already exists", info.ID)
		}
	}
	rows, err := printer.RegisterManual(a.registryPath, info)
	if err != nil {
		return err
	}
	if !info.Enabled {
		return nil // successful durable registration, with no execution authority
	}
	// The registry owns canonical IDs and retained disablement, not discovery hints.
	binding, err := config.PrinterBindingDigest(printer.SharingConfigForDevice(info))
	if err != nil {
		return err
	}
	var selected *printer.DeviceInfo
	for i := range rows {
		storedBinding, bindingErr := config.PrinterBindingDigest(printer.SharingConfigForDevice(rows[i]))
		if bindingErr == nil && storedBinding == binding {
			if selected != nil {
				return fmt.Errorf("manual printer endpoint has ambiguous registrations")
			}
			selected = &rows[i]
		}
	}
	if selected == nil {
		return fmt.Errorf("manual printer endpoint was not registered")
	}
	info = *selected
	if !info.Enabled {
		return nil
	}
	pc := printerConfigFromDeviceInfo(info)
	pc, err = a.resolveLocalPrinter(pc)
	if err != nil {
		return err
	}
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
	if remaining := a.runtimeActive.Load(); remaining > 0 {
		log.Printf("WARNING: leaving local queue open during shutdown because %d runtime task(s) are still in flight", remaining)
		return nil
	}
	// As with the physical-job ownership map below, zero ownership precedes
	// the last goroutine's final Done. Join that defer before closing resources.
	a.runtimeWG.Wait()
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
		a.execFenceReason.Store("odoo heartbeat 401: credential rejected; re-pair the Agent")
		a.execFence.Store(true)
		a.execFenceBackoffUntil.Store(now.Add(jitteredBackoff(lifecycleFenceBackoff)).UnixNano())
		log.Printf("Heartbeat rejected (401): credential rejected; new dispatch fenced and polls backed off for %v", lifecycleFenceBackoff)
	case statusCode == http.StatusConflict:
		reason := fmt.Sprintf("odoo heartbeat 409: %s", firstLineOfBody(body))
		a.execFence.Store(true)
		a.execFenceReason.Store(reason)
		a.execFenceBackoffUntil.Store(now.Add(jitteredBackoff(lifecycleFenceBackoff)).UnixNano())
		log.Printf("Agent execution fenced (%s); new dispatch refused and polls skipped until a heartbeat succeeds", reason)
	default:
		a.execFenceBackoffUntil.Store(now.Add(jitteredBackoff(lifecycleProbeBackoff)).UnixNano())
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

// fenceForCredentialRejection arms the lifecycle fence for a deterministic
// credential rejection observed outside the heartbeat path (poll 401 or WS
// dial 401). Heartbeats continue while fenced and a successful heartbeat
// clears the fence (clearLifecycleFence), so a misclassified transient
// rejection costs at most one heartbeat cycle of paused dispatch. The 401s
// fenced here are deterministic: Gateway WS 401 follows only a null
// validateAgent result (validateAgent throws now answer 503, WP3), and the
// poll route likewise 401s only on a null validateAgent result. In-flight
// executions are deliberately NOT disturbed, mirroring the heartbeat fence.
func (a *Agent) fenceForCredentialRejection(source string) {
	now := time.Now()
	a.execFenceReason.Store(source + ": credential rejected; re-pair the Agent")
	a.execFence.Store(true)
	a.execFenceBackoffUntil.Store(now.Add(jitteredBackoff(lifecycleFenceBackoff)).UnixNano())
	log.Printf("Credential rejected (%s): new dispatch fenced and polls backed off until a heartbeat succeeds", source)
}

// fencedForDispatch reports whether new local dispatch must be refused.
// Lock-free: safe on the hot dispatch path under -race.
func (a *Agent) fencedForDispatch() bool {
	return a.execFence.Load() || a.billingBlocked.Load()
}

// fenceReason returns the recorded fence cause for logs. Empty when clear.
func (a *Agent) fenceReason() string {
	if v := a.execFenceReason.Load(); v != nil {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	if a.billingBlocked.Load() {
		return "workspace billing blocked"
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
	// Serialize runtimeWG.Add against beginShutdown so asynchronous callers
	// (e.g. armSpoolerRefreshTimer's time.AfterFunc) cannot race runtimeWG.Wait.
	a.shutdownGate.RLock()
	select {
	case <-a.shutdownCh:
		a.shutdownGate.RUnlock()
		return
	default:
	}
	a.runtimeActive.Add(1)
	a.runtimeWG.Add(1)
	a.shutdownGate.RUnlock()
	go func() {
		defer func() {
			a.runtimeActive.Add(-1)
			a.runtimeWG.Done()
		}()
		fn()
	}()
}

func (a *Agent) waitForRuntimeUntil(deadline time.Time) bool {
	timer := time.NewTimer(max(time.Until(deadline), time.Millisecond))
	defer timer.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if a.runtimeActive.Load() == 0 {
			// Run has stopped launching roots; no tracked parent remains that
			// can register a child. Join the final Done defer after zero.
			a.runtimeWG.Wait()
			return true
		}
		select {
		case <-timer.C:
			return false
		case <-ticker.C:
		}
	}
}

func (a *Agent) Run(ctx context.Context) error {
	if a.cfg.Agent.ID == "" {
		log.Println("CRITICAL: Agent not registered. Staying alive so the desktop manager can pair it.")
		<-ctx.Done()
		return nil
	}

	log.Printf("Agent %s starting (ID: %s, %d printer(s) configured)", a.cfg.Agent.Name, a.cfg.Agent.ID, a.printerCount())

	// Crash recovery must run before any new delivery is accepted.
	if err := a.recoverInterruptedJobs(ctx); err != nil {
		return err
	}
	a.reportPendingTerminalStatuses(ctx)
	a.cleanupRetainedLocalJobs()

	// Direct Odoo mode uses one authenticated HTTP polling path. There is no
	// Cloud transport or Cloud-managed discovery session.
	a.launchTracked(func() { a.runRejectWorker(ctx) })
	a.launchTracked(func() { a.runTerminalReportWorker(ctx) })
	a.launchTracked(func() { a.runInitialAsyncDiscovery(ctx) })
	// Spooler change notifications accelerate inventory sync: a printer
	// added/removed/renamed in Windows, or a queue status change, triggers
	// a rescan + immediate heartbeat instead of waiting for the next tick.
	// Unavailability of the API degrades to the polling behaviour below.
	a.launchTracked(func() { a.watchSpoolerChanges(ctx) })
	a.launchTracked(func() { a.runOdooWebSocket(ctx) })
	go func() { _ = printer.WarmPDFium(ctx) }()

	heartbeatTicker := time.NewTicker(30 * time.Second)
	// 1s base tick: poll every 1s when WebSocket push is disconnected, or every
	// 5s as a backstop while WebSocket push is active.
	pollTicker := time.NewTicker(1 * time.Second)
	pollTick := 0
	cleanupTicker := time.NewTicker(localQueueCleanupInterval)
	defer heartbeatTicker.Stop()
	defer pollTicker.Stop()
	defer cleanupTicker.Stop()

	// Send an immediate heartbeat/poll on startup instead of waiting a full tick.
	a.launchTracked(func() { a.sendHeartbeatGuardedContext(ctx) })
	a.launchTracked(func() { a.pollJobsGuarded(ctx) })

	for {
		select {
		case <-ctx.Done():
			log.Println("Agent stopping...")
			shutdownDeadline := time.Now().Add(shutdownGrace)
			a.beginShutdown()
			if !a.waitForRuntimeUntil(shutdownDeadline) {
				// Capture metadata and OS/filesystem calls may not observe the
				// request context. Keep their ownership accounted for: Close
				// leaves SQLite open, and process teardown contains them.
				log.Printf("WARNING: shutdown grace elapsed with runtime tasks still in flight; leaving the local queue open for process teardown")
				return nil
			}
			// Control-plane draining is part of the same SCM stop budget. A
			// ten-second heartbeat tail must not be followed by a fresh 25s
			// physical-job grace (the service wrapper stops waiting at 27s).
			if !a.waitForJobsFor(time.Until(shutdownDeadline)) {
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
		case <-a.wsWakeCh:
			if a.fencedForDispatch() || a.lifecycleBackoffActive() {
				break
			}
			a.launchTracked(func() { a.pollJobsGuarded(ctx) })
		case <-a.heartbeatTrigger:
			// Out-of-cycle full snapshot (reconnect resync / spooler
			// change / completed discovery). Guarded like the tick: if a
			// heartbeat is already running it carries an equally fresh
			// snapshot, so skipping loses nothing.
			a.launchTracked(func() { a.sendHeartbeatGuardedContext(ctx) })
		case <-heartbeatTicker.C:
			// Never block the select loop: heartbeat probes TCP-reachability
			// of every configured printer, which can take seconds when offline.
			// Heartbeats are presence: they continue even while fenced so a
			// re-enabled agent is detected promptly (a success clears the
			// fence); only job acquisition below is gated.
			a.launchTracked(func() { a.sendHeartbeatGuardedContext(ctx) })
		case <-pollTicker.C:
			pollTick++
			if a.wsConnected.Load() && pollTick%5 != 0 {
				continue
			}
			if a.checkVisibilityPolicyChanged() {
				a.requestImmediateHeartbeat()
			}
			a.launchTracked(func() { a.reportPendingTerminalStatuses(ctx) })
			// Fenced (disabled/retired) or backing off (dead credential,
			// recent rejection): do not acquire new work. Terminal-outcome
			// replay above still runs — the Gateway must learn completed
			// work even from a fenced agent.
			if a.fencedForDispatch() || a.lifecycleBackoffActive() {
				break
			}
			// Odoo is the only print queue. Poll it directly on every tick;
			// stale pre-print claims are recovered by Odoo's claim lease.
			a.launchTracked(func() { a.pollJobsGuarded(ctx) })
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
// the Gateway acknowledges one with bounded valid JSON containing success:true
// and the requested terminal status. This is an Agent-local
// transactional outbox: it closes the crash window between the SQLite terminal
// write and the remote status report without ever re-running printer I/O.
func (a *Agent) reportPendingTerminalStatuses(ctx context.Context) {
	if !a.terminalReportMu.TryLock() {
		return
	}
	defer a.terminalReportMu.Unlock()

	// Keep stale terminal reports from delaying startup and claim hand-back.
	a.reportPendingPreDispatchReturns(ctx)
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	var err error
	if a.terminalReportThroughID == "" || a.terminalReportAfterID >= a.terminalReportThroughID {
		a.terminalReportAfterID = ""
		a.terminalReportThroughID, err = a.queue.PendingTerminalReportMaxID()
	}
	if err != nil {
		log.Printf("Terminal status outbox boundary scan failed: %v", err)
		return
	}
	reports, err := a.queue.PendingTerminalReportsAfter(32, a.terminalReportAfterID, a.terminalReportThroughID)
	if err == nil && len(reports) == 0 && a.terminalReportAfterID != "" {
		a.terminalReportAfterID = ""
		a.terminalReportThroughID, err = a.queue.PendingTerminalReportMaxID()
		if err == nil {
			reports, err = a.queue.PendingTerminalReportsAfter(32, "", a.terminalReportThroughID)
		}
	}
	if err != nil {
		log.Printf("Terminal status outbox scan failed: %v", err)
	}
	for _, report := range reports {
		if ctx.Err() != nil {
			return
		}
		if err := a.reportDurableTerminalResult(ctx, report); err != nil {
			log.Printf("Job %s: pending terminal status report failed: %v", report.ID, err)
		}
		a.terminalReportAfterID = report.ID
	}
}

// reportPendingPreDispatchReturns reserves each idle job under the SAME
// in-flight mutex used by dispatchJob. This closes the race where a new
// delivery might begin printing while a recovery worker returns its claim.
// No live waiter is ever requeued by this sweep.
func (a *Agent) reportPendingPreDispatchReturns(ctx context.Context) {
	// Do not delay service startup or heartbeat/poll ticks behind many stale
	// network requests. Remaining durable returns are retried next tick.
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	// Up to maxPendingJobs active waiters may sort ahead of abandoned claims.
	// Fetch that entire bounded prefix plus one hand-back batch; otherwise the
	// oldest four live waiters could starve all orphaned claims forever.
	const handBackBatch = 4
	pending, err := a.queue.PendingPreDispatchReturns(maxPendingJobs + handBackBatch)
	if err != nil {
		log.Printf("Pre-dispatch return outbox scan failed: %v", err)
		return
	}
	attempted := 0
	for _, item := range pending {
		if ctx.Err() != nil || attempted >= handBackBatch {
			return
		}
		a.inFlightMu.Lock()
		_, busy := a.inFlight[item.ID]
		if !busy {
			a.inFlight[item.ID] = struct{}{}
		}
		a.inFlightMu.Unlock()
		if busy {
			continue
		}
		attempted++
		func() {
			defer func() {
				a.inFlightMu.Lock()
				delete(a.inFlight, item.ID)
				a.inFlightMu.Unlock()
			}()
			// The reservation was established under inFlightMu. Recheck the
			// durable token before calling the Gateway: it may have changed
			// during an older, interrupted attempt.
			if a.queue.ClaimTokenFor(item.ID) != item.ClaimToken {
				return
			}
			reason := "agent_shutting_down"
			if printerID, _, found, err := a.queue.Get(item.ID); err == nil && found && !a.isPrinterAvailableToOdoo(printerID) {
				reason = "printer_not_shared"
			}
			if err := a.rejectJobExact(ctx, item.ID, item.ClaimToken, reason); err != nil {
				var rejected odooHandBackError
				if !errors.As(err, &rejected) || (rejected.status != http.StatusConflict && rejected.status != http.StatusNotFound) {
					log.Printf("Job %s: pre-dispatch claim return pending: %v", item.ID, err)
					return
				}
				// An authoritative 404/409 means this exact fenced claim can
				// no longer be returned. Discard only its LOCAL queued token;
				// the Gateway outcome and any newer claim remain untouched.
				log.Printf("Job %s: previous pre-dispatch claim is stale; clearing local return token", item.ID)
			}
			if err := a.queue.ClearPreDispatchClaim(item.ID, item.ClaimToken); err != nil {
				log.Printf("Job %s: pre-dispatch return acknowledged but local token clear failed: %v", item.ID, err)
			}
		}()
	}
}

// recoverInterruptedJobs reports jobs interrupted during physical execution.
// Their original output is unknown, so startup recovery only reports the stored
// outcome under its original claim. Legacy global reprint settings never reopen
// the operation; a deliberate new job requires reconciliation and authorization.
func (a *Agent) recoverInterruptedJobs(ctx context.Context) error {
	interrupted, err := a.queue.MarkInterrupted()
	if err != nil {
		return fmt.Errorf("recover interrupted local jobs: %w", err)
	}
	if a.cfg != nil && a.cfg.Agent.ReprintAfterCrash != nil && *a.cfg.Agent.ReprintAfterCrash {
		log.Printf("WARNING: deprecated reprint_after_crash=true is ignored; unknown physical output requires reconciliation and a separately authorized new operation.")
	}
	for _, job := range interrupted {
		log.Printf("WARNING: job %s on printer %s was interrupted during printing. Physical output is UNKNOWN (full, partial or none); reporting the original attempt without reprinting.", job.ID, job.PrinterID)
		a.updateJobStatus(ctx, job.ID, "failed", queue.InterruptedMarker+
			": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)", job.ClaimToken, job.SpoolerJobID)
	}
	if len(interrupted) > 0 {
		log.Printf("Crash recovery: %d interrupted job(s) retained as unknown; no automatic reprint is permitted.", len(interrupted))
	}
	return nil
}

func (a *Agent) dispatchJob(ctx context.Context, job map[string]interface{}) bool {
	return a.dispatchJobWithContexts(ctx, ctx, job)
}

// dispatchJobWithContexts separates the Agent execution lifecycle from the
// HTTP polling lifecycle. Once a job is admitted locally, its execution
// must survive a WS reconnect; only Agent shutdown cancels physical execution.
// Rejection/ACK side effects remain tied to the originating WS session.
func (a *Agent) dispatchJobWithContexts(executionCtx, sessionCtx context.Context, job map[string]interface{}) bool {
	fields, err := decodeJobFields(job)
	if err != nil {
		log.Printf("Received malformed job; rejecting execution: %v", err)
		return false
	}
	jobID := fields.ID
	pendingPrinter := fields.PrinterID

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
		// the odoo can re-queue the job without burning attempts. If the
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
		log.Printf("Job %s already has a process-local terminal physical result; refusing duplicate dispatch and scheduling fenced re-report", jobID)
		if !a.enqueueTerminalReReport(sessionCtx, jobID, terminal) {
			// No second print is permitted even when reporting is temporarily
			// unavailable. A later delivery can retry the same fenced report.
			log.Printf("Job %s: terminal re-report not queued; keeping in-process physical fence", jobID)
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
		log.Printf("Job %s dropped: printer %s has reached the per-printer pending ceiling (%d); handing it back to the odoo queue.", jobID, pendingPrinter, maxPendingJobsPerPrinter)
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
	if a.inFlightPrinters == nil {
		a.inFlightPrinters = make(map[string]string)
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
		log.Printf("Job %s dropped: %d jobs already in flight; handing it back to the odoo queue (pending_full).", jobID, maxPendingJobs)
		// Tell the odoo NOW so the job is requeued immediately instead of
		// sitting 'claimed' for the 90s lease. The odoo refunds the
		// delivery-attempt charge for this provably pre-execution return
		// (zero bytes sent) and consumes one retry instead, so a saturated
		// agent holding a big backlog cannot burn jobs into a delivery-budget
		// failure (see the reject gate in src/app/api/agent/jobs).
		// Best-effort: without a successful rejection the Gateway may retain an unknown outcome.
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
				// A panic can occur after the terminal result was durably
				// committed but before Gateway acknowledged it. Preserve the
				// original outcome, spooler ID and PDF output proof instead of
				// replacing them with a new panic outcome or dropping evidence.
				if readErr == nil && found && (localStatus == "success" || localStatus == "failed") {
					report, present, reportErr := a.queue.TerminalResultFor(jobID)
					if reportErr == nil && present {
						if err := a.reportDurableTerminalResult(executionCtx, report); err != nil {
							log.Printf("Job %s: original terminal result reconciliation after panic failed: %v", jobID, err)
						}
						return
					}
					log.Printf("Job %s: could not read original terminal result after panic: %v", jobID, reportErr)
				}
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
//   - Fence rejection (ErrStaleClaim) or any other explicit odoo
//     rejection (ErrTransitionRejected): the odoo evaluated our claim
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
		return false, "claim fence rejected by odoo"
	}
	if errors.Is(reportErr, ErrJobCanceled) {
		return false, "odoo reports job canceled by operator"
	}
	if errors.Is(reportErr, ErrTransitionRejected) {
		return false, "odoo explicitly rejected the printing transition"
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
// reportPrintingWithRetry retries transient transport/odoo hiccups on the
// claimed->printing transition before giving up. Permanent fence/cancel
// rejections and context cancellations stop immediately.
func (a *Agent) reportPrintingWithRetry(ctx context.Context, jobID, claimToken, statusTransport string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backoffs := []time.Duration{250 * time.Millisecond, 750 * time.Millisecond}
	var err error
	for attempt := 0; attempt <= len(backoffs); attempt++ {
		err = a.updateJobStatusWithTransport(ctx, jobID, "printing", "", claimToken, "", statusTransport)
		if err == nil || ctx.Err() != nil || errors.Is(err, ErrStaleClaim) || errors.Is(err, ErrJobCanceled) || errors.Is(err, ErrTransitionRejected) {
			return err
		}
		if attempt == len(backoffs) {
			return err
		}
		timer := time.NewTimer(jitteredBackoff(backoffs[attempt]))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

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
	a.rememberTerminalOutput(jobID, status, errMsg, claimToken, spoolerJobID, "")
}

func (a *Agent) rememberTerminalOutput(jobID, status, errMsg, claimToken, spoolerJobID, transport string) {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	if a.terminalExecution == nil {
		a.terminalExecution = make(map[string]terminalExecutionResult)
	}
	a.terminalExecution[jobID] = terminalExecutionResult{status: status, errMsg: errMsg, claimToken: claimToken, spoolerJobID: spoolerJobID, transport: transport}
}

func (a *Agent) deliveryReceivedAt(jobID string) time.Time {
	a.inFlightMu.Lock()
	defer a.inFlightMu.Unlock()
	return a.inFlightReceived[jobID]
}

// inFlightJobIDs returns up to limit ids of jobs currently held by the
// executor (waiting for an execution slot, running, or at the printer).
// Used for the heartbeat keep-alive (odoo print-lease extension).
// Each entry carries the delivery attempt's claim token: the odoo
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

// rejectJob hands a claimed job back to the odoo queue because the local
// executor is saturated (pendingSlots full). This is distinct from a real
// print failure: the agent is healthy, it just cannot accept the job right
// now. The odoo refunds the delivery attempt and increments the bounded
// retry budget. If the hand-back fails, delivery may remain unknown.
func (a *Agent) rejectJob(ctx context.Context, jobID, token, reason string) error {
	return a.rejectJobExact(ctx, jobID, token, reason)
}

// odooHandBackError preserves the status code for internal recovery of
// stale pre-dispatch claims. It is not a new HTTP or public API contract.
type odooHandBackError struct{ status int }

func (e odooHandBackError) Error() string {
	return fmt.Sprintf("odoo rejected job hand-back: HTTP %d", e.status)
}

// rejectJobExact is the fenced form used by the asynchronous rejection worker.
// Its claim token is immutable: it MUST NOT be replaced with a newer token
// that may now be active for the same job, otherwise an old saturation event
// could mutate the replacement claim.
func (a *Agent) rejectJobExact(ctx context.Context, jobID, token, reason string) error {
	reqURL := "/api/agent/ack"
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": "queued",
		"reason": reason,
		"error":  reason,
	}
	if token != "" {
		body["claimToken"] = token
	}
	resp, err := a.doAuthorizedRequest(ctx, "POST", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report pre-execution rejection: %v (delivery outcome may remain unknown)", jobID, err)
		return err
	}
	defer drainAndCloseBody(resp.Body)
	if resp.StatusCode >= 300 {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Job %s: failed to read odoo rejection body: %v", jobID, readErr)
		}
		log.Printf("Job %s: server rejected the pre-execution rejection (%d): %s", jobID, resp.StatusCode, string(respBody))
		return odooHandBackError{status: resp.StatusCode}
	}
	// A bare 2xx is not proof the hand-back applied: require the same shaped
	// acknowledgement as every other status report, so a misbehaving proxy
	// cannot silently drop the requeue while the agent stops tracking it.
	ackBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes+1))
	if readErr != nil || len(ackBody) > maxGatewayErrorBodyBytes {
		return fmt.Errorf("%w: unreadable or oversized hand-back acknowledgement", ErrTransitionRejected)
	}
	var accepted struct {
		OK      bool   `json:"ok"`
		Success bool   `json:"success"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal(ackBody, &accepted); err != nil {
		return fmt.Errorf("%w: invalid hand-back acknowledgement: %v", ErrTransitionRejected, err)
	}
	if !(accepted.OK || accepted.Success) || accepted.Status != "queued" {
		return fmt.Errorf("%w: Odoo did not acknowledge %q (status %q)", ErrTransitionRejected, "queued", accepted.Status)
	}
	return nil
}

func rejectKey(jobID, token, reason string) string {
	return jobID + "\x00" + token + "\x00" + reason
}

// enqueueReject never performs network I/O. It registers at most one queued
// rejection per (job, claim token, reason), then places it into a bounded
// channel. A full queue drops the best-effort signal; the Gateway may retain
// an unknown outcome until the original attempt is reconciled.
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
		log.Printf("Job %s: rejection queue full (%d); delivery outcome may remain unknown", jobID, maxRejectQueue)
		return false
	}
}

// enqueueTerminalReReport is nonblocking for the polling worker. Duplicate
// frames coalesce while a re-report is queued or executing. Queue admission
// never alters the in-process physical fence; saturation only delays a
// best-effort status update, not authorization to print again.
func (a *Agent) enqueueTerminalReReport(ctx context.Context, jobID string, result terminalExecutionResult) bool {
	if ctx == nil || ctx.Err() != nil || jobID == "" || result.claimToken == "" {
		return false
	}
	key := jobID + "\x00" + result.claimToken
	a.terminalReportQueueMu.Lock()
	defer a.terminalReportQueueMu.Unlock()
	if _, exists := a.terminalReportPending[key]; exists {
		return true
	}
	work := terminalReportWork{ctx: ctx, jobID: jobID, result: result, key: key}
	select {
	case a.terminalReportQueue <- work:
		a.terminalReportPending[key] = struct{}{}
		return true
	default:
		log.Printf("Job %s: terminal re-report queue full (%d), retaining physical fence", jobID, maxTerminalReportQueue)
		return false
	}
}

// runTerminalReportWorker owns bounded background HTTP retries for duplicate
// terminal deliveries. It uses the original session context for cancellation
// and *original* claim token for Gateway fencing; stale claims may be rejected
// authoritatively, but are never rewritten to a newer delivery's token.
func (a *Agent) runTerminalReportWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case work := <-a.terminalReportQueue:
			if ctx.Err() == nil && work.ctx.Err() == nil {
				r := work.result
				if err := a.updateJobStatusWithTransport(work.ctx, work.jobID, r.status, r.errMsg, r.claimToken, r.spoolerJobID, r.transport); err != nil {
					log.Printf("Job %s: process-local terminal re-report failed: %v", work.jobID, err)
				}
			}
			a.terminalReportQueueMu.Lock()
			delete(a.terminalReportPending, work.key)
			a.terminalReportQueueMu.Unlock()
		}
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
// stop. The durable queue and Gateway retain evidence for recovery; an
// interrupted or possibly delivered attempt can remain physically unknown.
//
// Caller contract (sync.WaitGroup rule): no wg.Add may be concurrent with
// this Wait. Production shutdown satisfies it via the inFlightMu gate in
// dispatchJob. Tests driving delivery from a background goroutine (WS
// handler) must first synchronize past the Add before calling this.
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

// Physical workers retain their printer mutex until they actually return.
// Reconciliation and queued jobs may stop waiting without releasing that
// ownership: an uncancellable native call must not pin runtimeWG shutdown or
// a cancelled waiter's executor reservation indefinitely.
func lockPrinterUntil(lock *sync.Mutex, done <-chan struct{}) bool {
	for {
		select {
		case <-done:
			return false
		default:
		}
		if lock.TryLock() {
			return true
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-done:
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
}

// sendHeartbeatGuarded makes heartbeat ticks non-reentrant: if the previous
// heartbeat is still running (slow odoo, many offline printers) the tick
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

// requestImmediateHeartbeat asks the Run loop for an out-of-cycle
// heartbeat. Every heartbeat carries a complete inventory snapshot, so
// one immediate heartbeat is also a full resync: it is requested after a
// Agent restart, after a spooler change notification rescan, and
// after any completed discovery, so the Gateway converges to the Agent's
// actual inventory within seconds instead of at the next 30s tick.
func (a *Agent) visibilityPolicyStamp() string {
	if a.configPath == "" {
		return ""
	}
	info, err := os.Stat(config.PrinterVisibilityPath(a.configPath))
	if err != nil {
		return "absent"
	}
	return fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
}

func (a *Agent) checkVisibilityPolicyChanged() bool {
	stamp := a.visibilityPolicyStamp()
	if stamp == "" {
		return false
	}
	if a.lastVisibilityStamp == "" {
		a.lastVisibilityStamp = stamp
		return false
	}
	if stamp != a.lastVisibilityStamp {
		a.lastVisibilityStamp = stamp
		return true
	}
	return false
}

func (a *Agent) requestImmediateHeartbeat() {
	if a.heartbeatTrigger == nil {
		return
	}
	select {
	case a.heartbeatTrigger <- struct{}{}:
	default:
	}
}

// refreshSpoolerInventory rescans the fast local sources after a Windows
// spooler change notification, persists and reconciles the result exactly
// like a discovery run, then pushes an immediate heartbeat. Non-reentrant
// and debounced: a burst of change events for one install/uninstall
// collapses into at most one rescan per spoolerRefreshDebounce window.
const spoolerRefreshDebounce = 2 * time.Second

func (a *Agent) refreshSpoolerInventory(ctx context.Context) {
	if !a.spoolerRefreshMu.TryLock() {
		// A rescan is already running; the change it may miss is owed a
		// trailing pass once the current one finishes.
		a.spoolerRefreshPending.Store(true)
		a.armSpoolerRefreshTimer(ctx)
		return
	}
	defer a.spoolerRefreshMu.Unlock()
	if last := a.spoolerRefreshLast.Load(); last > 0 && time.Since(time.Unix(0, last)) < spoolerRefreshDebounce {
		a.spoolerRefreshPending.Store(true)
		a.armSpoolerRefreshTimer(ctx)
		return
	}
	a.spoolerRefreshLast.Store(time.Now().UnixNano())
	a.spoolerRefreshPending.Store(false)
	result := printer.DiscoverQuick(a.cfg, a.registryPath)
	merged, err := a.persistLiveDiscovery(result)
	if err != nil {
		log.Printf("[spooler-watch] change rescan could not be persisted; keeping previous inventory: %v", err)
		return
	}
	a.reconcileRegistryPrinters(merged)
	log.Printf("[spooler-watch] inventory refreshed after spooler change: %d printer(s)", len(merged))
	a.requestImmediateHeartbeat()
	if a.spoolerRefreshPending.Swap(false) {
		a.armSpoolerRefreshTimer(ctx)
	}
}

// armSpoolerRefreshTimer schedules the single trailing rescan owed to
// change events that arrived during a running/debounced rescan, so a
// dropped event can never silently lose a printer addition, removal,
// or rename.
func (a *Agent) armSpoolerRefreshTimer(ctx context.Context) {
	if !a.spoolerRefreshTimerArmed.CompareAndSwap(false, true) {
		return
	}
	time.AfterFunc(spoolerRefreshDebounce, func() {
		a.spoolerRefreshTimerArmed.Store(false)
		if ctx.Err() != nil {
			return
		}
		if a.spoolerRefreshPending.Load() {
			a.launchTracked(func() { a.refreshSpoolerInventory(ctx) })
		}
	})
}

// watchSpoolerChanges runs the Windows spooler change-notification watch
// for the life of the agent. The underlying watch returns permanently
// when the notification channel breaks — most commonly a spooler
// service restart — so this loop RE-ARMS it with backoff for as long as
// the agent runs, and every re-arm is preceded by a catch-up rescan so
// changes that happened while the watch was down are not missed. The
// watcher remains an accelerator, never a dependency: while it is down
// the heartbeat keeps reporting the last known inventory.
func (a *Agent) watchSpoolerChanges(ctx context.Context) {
	backoff := 2 * time.Second
	for {
		watchStart := time.Now()
		err := printer.WatchSpoolerChanges(ctx, func() {
			a.launchTracked(func() { a.refreshSpoolerInventory(ctx) })
		})
		if ctx.Err() != nil {
			return
		}
		if time.Since(watchStart) >= 60*time.Second {
			backoff = 2 * time.Second
		}
		wait := jitteredBackoff(backoff)
		if err != nil {
			log.Printf("[spooler-watch] spooler change notifications interrupted (%v); re-arming in %s", err, wait)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if backoff < 60*time.Second {
			backoff *= 2
			if backoff > 60*time.Second {
				backoff = 60 * time.Second
			}
		}
		// Catch up on any change the dead watch never delivered.
		a.launchTracked(func() { a.refreshSpoolerInventory(ctx) })
	}
}

// pollJobsGuarded is the non-reentrant variant for HTTP polling and WS wakeups.
// A wakeup arriving while a poll is in flight sets pollPending so it coalesces
// into one immediate follow-up poll instead of being dropped until the next tick.
func (a *Agent) pollJobsGuarded(ctx context.Context) {
	for {
		if !a.pollMu.TryLock() {
			a.pollPending.Store(true)
			return
		}
		func() {
			defer a.pollMu.Unlock()
			a.pollPending.Store(false)
			a.pollJobs(ctx)
		}()
		if !a.pollPending.Load() || ctx.Err() != nil || a.fencedForDispatch() || a.lifecycleBackoffActive() {
			return
		}
	}
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
	return printerConfigFacts(pc), true
}

func printerConfigFacts(pc config.PrinterConfig) printer.TransportFacts {
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
		caps = append([]string(nil), explicit...)
	}
	geometry, _ := printer.ConfiguredGeometry(pc)
	return printer.TransportFacts{
		Geometry:                  geometry,
		Protocol:                  family,
		Connection:                pc.NormalizedType(),
		SupportedProtocol:         caps,
		SupportedProtocolDeclared: supportedProtocolsDeclared,
	}
}

func printStatusTransport(facts printer.TransportFacts) string {
	connection := strings.ToLower(strings.TrimSpace(facts.Connection))
	protocol := strings.ToLower(strings.TrimSpace(facts.Protocol))
	if connection == "spooler" || connection == "windows_spooler" || (connection == "usb" && protocol == "spooler") {
		return "windows_spooler"
	}
	if connection == "ipp" || connection == "ipps" {
		return connection
	}
	if connection == "network" && (protocol == "ipp" || protocol == "ipps") {
		return protocol
	}
	if connection == "network" && (protocol == "raw" || protocol == "escpos" || protocol == "zpl" || protocol == "tspl") {
		return protocol + "_tcp"
	}
	if connection == "usb" && (protocol == "raw" || protocol == "escpos" || protocol == "zpl" || protocol == "tspl") {
		return protocol + "_usb"
	}
	return ""
}

func (a *Agent) printerStatusPayload() []map[string]interface{} {
	return a.printerStatusPayloadWithSharing(a.loadLocalPrinterVisibility())
}

func (a *Agent) printerStatusPayloadWithSharing(snapshot localPrinterVisibilitySnapshot) []map[string]interface{} {
	rows, _ := a.printerStatusPayloadWithSharingResult(snapshot)
	return rows
}

// The returned completeness bit is about whether local operator disablement
// could be read before AND after status probes. No rows + an unreadable policy
// is not evidence that the fleet was removed: the Odoo must retain its
// previous inventory instead of applying an authoritative empty snapshot.
func (a *Agent) printerStatusPayloadWithSharingResult(sharing localPrinterVisibilitySnapshot) ([]map[string]interface{}, bool) {
	disabled, err := printer.LoadLocalPrinterDisablement(a.cfg, a.registryPath)
	if err != nil {
		log.Printf("Printer inventory proof withheld: local disablement could not be read: %v", err)
		return nil, false
	}
	inventoryComplete := true
	invalidIDs := 0
	omittedDisabled, omittedUnshared, omittedVirtual := 0, 0, 0
	a.printersMu.RLock()
	ids := make([]string, 0, len(a.printers))
	isVirtualByID := make(map[string]bool, len(a.printers))
	printerClassByID := make(map[string]string, len(a.printers))
	for id := range a.printers {
		pc := a.printerConfigs[id]
		if disabled.Disabled(pc) {
			omittedDisabled++
			continue
		}
		if shared, err := sharing.shared(pc); !shared || err != nil {
			omittedUnshared++
			continue
		}
		if !printer.ValidGatewayPrinterID(id) {
			inventoryComplete = false
			invalidIDs++
			continue
		}
		c := printer.ClassifyDeviceInfo(printer.DeviceInfo{
			Name: pc.Name, PrinterType: pc.PrinterType,
			SpoolerName: pc.SpoolerName, Endpoint: pc.Endpoint, ConnectionType: pc.NormalizedType(),
			Protocol: pc.NormalizedProtocolOrUnknown(), Capabilities: pc.Capabilities,
		})
		if c.IsRedirected || c.IsUnusable {
			omittedVirtual++
			continue
		}
		isVirtualByID[id] = c.IsVirtual
		printerClassByID[id] = string(c.Class)
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
	if invalidIDs > 0 {
		log.Printf("Printer inventory proof withheld: %d local printer ID(s) exceed the Gateway wire contract", invalidIDs)
	}
	sort.Strings(ids)

	statuses := make([]string, len(ids))
	details := make([]string, len(ids))
	reasons := make([]string, len(ids))
	rawStatuses := make([]string, len(ids))
	geometries := make([]*printer.Geometry, len(ids))
	verifications := make([]*printer.OperationalVerification, len(ids))
	observedCapabilities := make([]map[string]interface{}, len(ids))

	type probeResult struct {
		verification    *printer.OperationalVerification
		verificationErr string
		geometry        *printer.Geometry
		capabilities    map[string]interface{}
		idx             int
		status          string
		detail          string
		reason          string
		rawStatus       string
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
			statuses[i] = "unknown"
			reasons[i] = "probe_still_running"
			probed[i] = true
			continue
		}
		works = append(works, probeWork{idx: i, pid: id, p: printerByID[id], state: state})
	}

	workers := len(works)
	if workers > maxHeartbeatProbeConcurrency {
		workers = maxHeartbeatProbeConcurrency
	}
	workQueue := make(chan probeWork, len(works))
	for i := 0; i < workers; i++ {
		go func() {
			for work := range workQueue {
				func() {
					defer func() {
						work.state.running.Store(false)
						a.deleteProbeState(work.pid)
					}()
					status, detail, reason, rawStatus := "unknown", "", "", ""
					var geometry *printer.Geometry
					var verification *printer.OperationalVerification
					var verificationErr error
					var capabilitySnapshot map[string]interface{}
					func() {
						defer func() {
							if r := recover(); r != nil {
								status, detail, reason, geometry, verification, capabilitySnapshot = "unknown", "", "probe_panic", nil, nil, nil
								log.Printf("Status probe panic for %s: %v", work.pid, r)
							}
						}()
						observed := work.p.Status()
						if !a.recordPrinterProbeResult(work.pid, configByID[work.pid], work.p, observed) {
							reason = "probe_result_discarded"
							return
						}
						status = observed
						geometryCtx, cancelGeometry := context.WithTimeout(context.Background(), 3*time.Second)
						geometry, _ = printer.CurrentGeometry(geometryCtx, work.p, configByID[work.pid])
						cancelGeometry()
						verification, verificationErr = printer.ProbeOperationalVerification(context.Background(), work.p, configByID[work.pid])
						if reporter, ok := work.p.(interface{ ObservedCapabilities() map[string]interface{} }); ok {
							capabilitySnapshot = reporter.ObservedCapabilities()
						}
						if reporter, ok := work.p.(interface{ StatusDetail() string }); ok {
							detail = boundedDiscoveryText(strings.TrimSpace(reporter.StatusDetail()), 255)
						}
						if reporter, ok := work.p.(interface{ StatusRawHex() string }); ok {
							rawStatus = reporter.StatusRawHex()
						}
						if !a.printerObservationCurrent(work.pid, work.p, configByID[work.pid]) {
							status, detail, reason, geometry, verification, capabilitySnapshot = "unknown", "", "probe_result_stale", nil, nil, nil
							verificationErr = nil
							rawStatus = ""
							return
						}
						if status == "unknown" && detail == "" {
							reason = "probe_completed_unknown"
						} else {
							reason = detail
						}
					}()
					verificationErrText := ""
					if verificationErr != nil {
						verificationErrText = boundedDiscoveryText(strings.TrimSpace(verificationErr.Error()), 255)
					}
					results <- probeResult{idx: work.idx, status: status, detail: detail, reason: reason, rawStatus: rawStatus, geometry: geometry, verification: verification, verificationErr: verificationErrText, capabilities: capabilitySnapshot}
				}()
			}
		}()
	}

	for _, work := range works {
		workQueue <- work
	}
	close(workQueue)

	pendingProbes := len(works)
	budgetTimer := time.NewTimer(15 * time.Second)
	defer budgetTimer.Stop()
	var warningC <-chan time.Time = budgetTimer.C
	for pendingProbes > 0 {
		select {
		case res := <-results:
			statuses[res.idx] = res.status
			details[res.idx] = res.detail
			reasons[res.idx] = res.reason
			rawStatuses[res.idx] = res.rawStatus
			geometries[res.idx] = res.geometry
			verifications[res.idx] = res.verification
			observedCapabilities[res.idx] = res.capabilities
			if a.observations != nil {
				a.observations.record(ids[res.idx], res.geometry, res.verification, res.verificationErr)
			}
			probed[res.idx] = true
			pendingProbes--
		case <-warningC:
			warningC = nil
			deferred := 0
			for i := range ids {
				if !probed[i] {
					statuses[i] = "unknown"
					reasons[i] = "probe_batch_budget_exceeded"
					probed[i] = true
					pendingProbes--
					deferred++
				}
			}
			log.Printf("WARNING: Printer status probe batch exceeded 15s budget; %d slow probe(s) deferred to background (current status unknown)", deferred)
		}
	}

	disabled, err = printer.LoadLocalPrinterDisablement(a.cfg, a.registryPath)
	if err != nil {
		log.Printf("Printer inventory proof withheld after probes: local disablement could not be read: %v", err)
		return nil, false
	}

	result := make([]map[string]interface{}, 0, len(ids))
	omittedDisabledAfterProbe := 0
	for i, id := range ids {
		pc := configByID[id]
		if disabled.Disabled(pc) {
			omittedDisabledAfterProbe++
			continue
		}
		nt := pc.NormalizedType()
		proto := pc.NormalizedProtocolOrUnknown()
		deviceClass := normalizeDeviceClass(pc.PrinterType)
		printerType := normalizePrinterType(pc.PrinterType)
		isVirtual := isVirtualByID[id]
		entry := map[string]interface{}{
			"sharedWithGateway": true,
			"id":                id,
			"name":              heartbeatPrinterName(pc.Name, id),
			"displayName":       boundedDiscoveryText(pc.Name, 255),
			"printerType":       printerType,
			"deviceClass":       deviceClass,
			"connectionType":    nt,
			"protocol":          proto,
			"status":            statuses[i],
			"isVirtual":         isVirtual,
			"is_virtual":        isVirtual,
			"config":            endpointToConfig(pc),
		}
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
		if nt == "network" || nt == "ipp" || nt == "ipps" {
			if host, portStr, err := net.SplitHostPort(pc.Endpoint); err == nil && !strings.Contains(pc.Endpoint, "://") {
				entry["networkAddress"] = host
				if p, err := strconv.Atoi(portStr); err == nil {
					entry["port"] = p
				}
			} else {
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

		caps := make(map[string]interface{}, len(pc.Capabilities)+1)
		for k, v := range pc.Capabilities {
			if k == "_raw" {
				continue
			}
			caps[k] = v
		}
		delete(caps, "status_detail")
		delete(caps, "geometry")
		delete(caps, "ipp_capabilities")
		delete(caps, "operational_verification")
		if verifications[i] != nil {
			caps["operational_verification"] = verifications[i]
		}
		if observed, ok := observedCapabilities[i]["ipp_capabilities"]; ok {
			caps["ipp_capabilities"] = observed
		}
		if geometries[i] != nil {
			caps["geometry"] = geometries[i]
		}
		if pc.PaperWidthMM > 0 && pc.PaperWidthMM <= 1000 {
			caps["paper_width_mm"] = pc.PaperWidthMM
		}
		facts := printerConfigFacts(pc)
		facts.Geometry = geometries[i]
		if _, ok := caps["supported_protocols"]; !ok {
			caps["supported_protocols"] = printer.SupportedProtocolsForDevice(facts)
		}
		if details[i] != "" {
			caps["status_detail"] = details[i]
		}
		if reasons[i] != "" {
			caps["status_reason"] = reasons[i]
		}
		if rawStatuses[i] != "" {
			caps["spooler_status_raw"] = rawStatuses[i]
		}
		if isVirtual {
			caps["is_virtual"] = true
			if clsName := printerClassByID[id]; clsName != "" {
				caps["printer_class"] = clsName
			}
		}
		if len(caps) > 0 {
			entry["capabilities"] = caps
		}
		result = append(result, entry)
	}
	if omittedDisabled+omittedUnshared+invalidIDs+omittedVirtual+omittedDisabledAfterProbe > 0 {
		log.Printf("Printer heartbeat omitted %d printer(s) by gate (not by probe): disabled=%d unshared_or_error=%d invalid_id=%d virtual_or_redirected=%d disabled_after_probe=%d; published=%d probed=%d",
			omittedDisabled+omittedUnshared+invalidIDs+omittedVirtual+omittedDisabledAfterProbe,
			omittedDisabled, omittedUnshared, invalidIDs, omittedVirtual, omittedDisabledAfterProbe, len(result), len(ids))
	}
	return result, inventoryComplete
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
		if pc.USBVID != "" {
			if vid, err := config.ParseUSBID(pc.USBVID); err == nil {
				cfgMap["vid"] = int(vid)
			}
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			if pid, err := config.ParseUSBID(pc.USBPID); err == nil {
				cfgMap["pid"] = int(pid)
			}
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
	case "usb":
		cfgMap["address"] = strings.TrimSpace(pc.Endpoint)
		if pc.SpoolerName != "" {
			cfgMap["spooler_name"] = pc.SpoolerName
		}
		if pc.USBVID != "" {
			if vid, err := config.ParseUSBID(pc.USBVID); err == nil {
				cfgMap["vid"] = int(vid)
			}
			cfgMap["usb_vid"] = pc.USBVID
		}
		if pc.USBPID != "" {
			if pid, err := config.ParseUSBID(pc.USBPID); err == nil {
				cfgMap["pid"] = int(pid)
			}
			cfgMap["usb_pid"] = pc.USBPID
		}
		if pc.USBSerial != "" {
			cfgMap["serial"] = pc.USBSerial
			cfgMap["usb_serial"] = pc.USBSerial
		}
		if pc.SpoolerName == "" {
			cfgMap["diagnostic"] = "Direct USB transport requires a Windows device interface path; use a spooler_name only for Windows print-queue transport"
		}
	case "ipp", "ipps":
		cfgMap["address"] = pc.Endpoint
		cfgMap["ipp_url"] = pc.Endpoint
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
	if pc.Capabilities != nil {
		for k, v := range pc.Capabilities {
			switch k {
			case "protocol", "address", "ip", "port", "spooler_name", "vid", "pid", "serial", "usb_vid", "usb_pid", "usb_serial", "ipp_url", "host", "printer_type", "_raw", "geometry", "geometry_profile", "operational_verification", "output_profile_id", "directory", "output_directory", "pdf_output_directory":
				continue
			}
			cfgMap[k] = v
		}
	}
	if pc.GeometryProfile != nil {
		cfgMap["geometry_profile"] = pc.GeometryProfile
	}

	if pc.PaperWidthMM > 0 && pc.PaperWidthMM <= 1000 {
		cfgMap["paper_width_mm"] = pc.PaperWidthMM
		cfgMap["paper_widths"] = []interface{}{pc.PaperWidthMM}
	}
	if pc.PrinterType != "" {
		cfgMap["printer_type"] = pc.PrinterType
	}
	return cfgMap
}

func (a *Agent) reconcileRegistryPrinters(infos []printer.DeviceInfo) {
	disabled := printer.NewLocalPrinterDisablement(a.cfg, infos)
	a.printersMu.Lock()
	a.reapRetiredPrintersLocked()
	a.printersMu.Unlock()

	infos = printer.RuntimeInventoryPrinters(infos)

	yamlOwned := make(map[string]struct{}, len(a.cfg.Printers))
	for _, pc := range a.cfg.Printers {
		yamlOwned[pc.ID] = struct{}{}
	}

	present := make(map[string]struct{}, len(infos))
	for _, di := range infos {
		if _, ownedByYAML := yamlOwned[di.ID]; ownedByYAML {
			continue
		}
		pc, err := a.resolveLocalPrinter(printerConfigFromDeviceInfo(di))
		if err != nil || disabled.Disabled(pc) {
			continue
		}
		if _, err := a.mergeDiscoveredPrinter(di); err != nil {
			log.Printf("WARNING: registry printer %q (%s) not initialized: %v", di.ID, di.Name, err)
			continue
		}
		present[di.ID] = struct{}{}
	}

	a.printersMu.Lock()
	var removed []string
	for id := range a.registryOwned {
		if _, stillPresent := present[id]; !stillPresent {
			removed = append(removed, id)
		}
	}
	a.registryOwned = present
	var disabledRuntime []string
	for id, pc := range a.printerConfigs {
		if disabled.Disabled(pc) {
			disabledRuntime = append(disabledRuntime, id)
		}
	}
	a.printersMu.Unlock()

	for _, id := range removed {
		lock := a.getPrinterLock(id)
		if !lockPrinterUntil(lock, a.shutdownCh) {
			return
		}
		a.printersMu.Lock()
		if _, stillPresent := present[id]; !stillPresent {
			a.retirePrinterLocked(id)
		}
		a.printersMu.Unlock()
		lock.Unlock()
		a.deleteProbeState(id)
	}
	for _, id := range disabledRuntime {
		a.removePrinterRuntime(id)
	}
}

func (a *Agent) removePrinterRuntime(id string) {
	lock := a.getPrinterLock(id)
	if !lockPrinterUntil(lock, a.shutdownCh) {
		return
	}
	defer lock.Unlock()

	a.printersMu.Lock()
	a.retirePrinterLocked(id)
	a.printersMu.Unlock()
	a.deleteProbeState(id)
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
	infos = printer.RuntimeInventoryPrinters(infos)
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
	sharing := a.loadLocalPrinterVisibility()
	privateIDs, sharingComplete := a.hiddenPrinterIDs(sharing)
	if !sharingComplete {
		inventoryComplete = false
		log.Printf("Heartbeat sharing inventory incomplete: local policy or execution binding could not be read")
	}
	printerPayload, printerInventoryComplete := a.printerStatusPayloadWithSharingResult(sharing)
	if !printerInventoryComplete {
		// Local disablement may change between registry reload and status
		// probes, and invalid Gateway IDs cannot be included in the wire snapshot.
		// Neither case proves that the omitted printers vanished.
		// Keep presence/desired ACKs flowing, but forbid Gateway absence
		// reconciliation for this heartbeat snapshot.
		inventoryComplete = false
		log.Printf("Heartbeat inventory incomplete: local printer inventory could not be safely projected")
	}

	// Heartbeats are paginated at the transport boundary. The Gateway still
	// enforces 500 printers / page, but the Agent never truncates a real
	// inventory: every printer is delivered across one or more pages. The
	// auxiliary desired-state ACKs are paginated too, while Odoo-managed IDs
	// are scoped to the printer IDs in the same page so a stale local registry
	// entry can never bypass the ownership fence merely because it landed on a
	// different page.
	keepAlivePairs := a.inFlightJobIDs(64)
	pages := buildDirectHeartbeatPayloadPages(printerPayload, keepAlivePairs)
	if len(pages) == 0 {
		log.Printf("Heartbeat snapshot exceeds a bounded Gateway page; retaining the previous inventory and lifecycle fence")
		return
	}
	for pageIndex, payload := range pages {
		if parent.Err() != nil {
			return
		}
		_ = inventoryComplete
		directPayload := map[string]interface{}{
			"printers":          printerPayloadForPage(payload),
			"keepAliveJobIds":   payload["keepAliveJobIds"],
			"privatePrinterIds": privateIDs,
		}
		heartbeatCtx, cancel := context.WithTimeout(parent, 15*time.Second)
		resp, err := a.doAuthorizedRequest(heartbeatCtx, "POST", reqURL, directPayload)
		if err != nil {
			cancel()
			log.Printf("Heartbeat page %d/%d failed: %v", pageIndex+1, len(pages), err)
			return
		}

		// The response body must be read BEFORE the request context is canceled.
		// Cancelling first aborted the body read, which produced
		// "response read failed: context canceled" on every cycle and returned
		// early. The 15s budget still bounds request + body read.
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxHeartbeatBytes+1))
		drainAndCloseBody(resp.Body)
		cancel()
		if readErr != nil || len(body) > maxHeartbeatBytes {
			log.Printf("Heartbeat page %d/%d response read failed or exceeded the byte limit: %v", pageIndex+1, len(pages), readErr)
			return
		}
		if resp.StatusCode >= 300 {
			log.Printf("Heartbeat page %d/%d rejected (%d): %s", pageIndex+1, len(pages), resp.StatusCode, firstLineOfBody(body))
			a.noteHeartbeatRejection(resp.StatusCode, body)
			return
		}
		if parent.Err() != nil {
			return
		}

		var hbResp struct {
			OK                 bool            `json:"ok"`
			Success            bool            `json:"success"`
			BillingBlocked     bool            `json:"billingBlocked"`
			LicenseBundle      json.RawMessage `json:"licenseBundle"`
			OdooDBUUID         string          `json:"odooDbUuid"`
			DisabledPrinterIDs []string        `json:"disabledPrinterIds"`
			SkippedPrinters    []struct {
				ID     string `json:"id"`
				Reason string `json:"reason"`
			} `json:"skippedPrinters"`
		}
		if err := json.Unmarshal(body, &hbResp); err != nil || !(hbResp.OK || hbResp.Success) {
			log.Printf("Direct Odoo heartbeat page %d/%d was not acknowledged: parse error=%v, ok=%t", pageIndex+1, len(pages), err, hbResp.OK || hbResp.Success)
			return
		}

		if parent.Err() != nil {
			return
		}
		a.applyOdooLicense(hbResp.LicenseBundle, hbResp.OdooDBUUID, "heartbeat")
		disabledSet := make(map[string]struct{}, len(hbResp.DisabledPrinterIDs))
		for _, id := range hbResp.DisabledPrinterIDs {
			if id = strings.TrimSpace(id); id != "" {
				disabledSet[id] = struct{}{}
			}
		}
		a.printersMu.Lock()
		a.odooDisabledPrinters = disabledSet
		a.printersMu.Unlock()
		if hbResp.BillingBlocked {
			if !a.billingBlocked.Swap(true) {
				log.Printf("[heartbeat] workspace billing is blocked; odoo is withholding printer/job execution until subscription is resolved")
			}
		} else if a.billingBlocked.Swap(false) {
			log.Printf("[heartbeat] workspace billing block cleared")
		}
		if len(hbResp.SkippedPrinters) > 0 {
			for _, sp := range hbResp.SkippedPrinters {
				log.Printf("[heartbeat] printer %q rejected by odoo: %s", sp.ID, sp.Reason)
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
	defer drainAndCloseBody(resp.Body)

	if resp.StatusCode != http.StatusOK {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Poll rejected (%d); failed to read error body: %v", resp.StatusCode, readErr)
		}
		log.Printf("Poll rejected (%d): %s", resp.StatusCode, string(body))
		// WP3 (STATIC REVIEW ONLY, B3-08): a poll 401 is a deterministic
		// credential/lifecycle/tenant rejection (the poll route 401s only
		// on a null validateAgent result), so fence like the heartbeat
		// path instead of retrying until the next heartbeat notices. The
		// acquisition loop is already fence-gated and heartbeats continue
		// while fenced, so a successful heartbeat resumes polling.
		if resp.StatusCode == http.StatusUnauthorized {
			a.fenceForCredentialRejection("odoo poll 401")
		} else if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= http.StatusInternalServerError {
			backoff := lifecycleFenceBackoff
			if ra := strings.TrimSpace(resp.Header.Get("Retry-After")); ra != "" {
				if secs, convErr := strconv.Atoi(ra); convErr == nil && secs > 0 {
					if secs > 300 {
						secs = 300
					}
					backoff = time.Duration(secs) * time.Second
				}
			}
			a.execFenceBackoffUntil.Store(time.Now().Add(jitteredBackoff(backoff)).UnixNano())
		}
		return
	}

	jobs, err := decodeBoundedPollJobs(resp.Body, pollJobsByteLimit, maxClaimBatch)
	if err != nil {
		log.Printf("Poll: rejected invalid or oversized job batch before dispatch: %v", err)
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

	posJob := isPOSPrintJob(fields)
	if a.licenseGuard != nil {
		if degradedReason, licErr := a.licenseGuard.CheckPrintAllowedForJob(time.Now().UTC(), posJob); licErr != nil {
			log.Printf("Job %s blocked by license guard: %v", jobID, licErr)
			a.rejectJob(ctx, jobID, claimToken, "license_blocked")
			return
		} else if degradedReason != "" {
			log.Printf("Job %s (POS documentType=%q): license guard degraded (%s); continuing so POS printing is never blocked", jobID, fields.DocumentType, degradedReason)
		}
		if activePrinters := a.sharedPrinterCount(); activePrinters > 0 {
			if limitErr := a.licenseGuard.CheckPrinterLimit(activePrinters); limitErr != nil {
				if posJob {
					log.Printf("Job %s (POS documentType=%q): license printer limit exceeded (%d active: %v); degrading gracefully so POS printing is never blocked", jobID, fields.DocumentType, activePrinters, limitErr)
				} else {
					log.Printf("Job %s blocked by license printer limit (%d active): %v", jobID, activePrinters, limitErr)
					a.rejectJob(ctx, jobID, claimToken, "license_printer_limit")
					return
				}
			}
		}
	}

	// Local idempotency: a job that already printed successfully on THIS
	// agent is never printed again, no matter how often it is delivered. The
	// stored terminal result retains the ORIGINAL execution claim. A new
	// delivery token cannot turn earlier output into evidence for a new attempt.
	//
	// A locally FAILED job with a PROVABLE not-printed outcome is retryable
	// (the odoo only re-delivers after a fenced reclaim that increments
	// its retry budget). A locally failed job whose outcome is UNKNOWN
	// (partial delivery, crash mid-print) is NEVER automatically reprinted.
	// A legacy global option cannot authorize a new physical operation.
	if _, localStatus, found, err := a.queue.Get(jobID); err != nil {
		// The local ledger is the evidence base for all duplicate-print
		// protection. If it cannot be read we cannot prove this job has not
		// printed; refuse before dispatch (no bytes sent, safe retry).
		log.Printf("Job %s: local queue lookup failed; refusing dispatch: %v", jobID, err)
		// Fenced pre-execution return refunds delivery and consumes a retry.
		a.rejectJob(ctx, jobID, claimToken, "ledger_unavailable")
		return
	} else if found && localStatus == "success" {
		log.Printf("Job %s already completed locally (success). Re-reporting terminal result instead of printing again.", jobID)
		result, present, readErr := a.queue.TerminalResultFor(jobID)
		if readErr != nil || !present {
			log.Printf("Job %s: terminal result unavailable for reconciliation: %v", jobID, readErr)
			return
		}
		if err := a.reportDurableTerminalResult(ctx, result); err != nil {
			log.Printf("Job %s: terminal result reconciliation failed: %v", jobID, err)
		}
		return
	} else if found && a.queue.WasOutcomeUnknown(jobID) {
		// This job already reached the printer in a previous attempt, so it
		// may have produced paper. The agent refuses a second execution
		// under any legacy policy value and re-reports the
		// unknown outcome instead of silently duplicating the document.
		// The LOCAL history is echoed verbatim (crash marker stays a crash
		// marker; partial delivery stays a partial-delivery marker).
		result, present, readErr := a.queue.TerminalResultFor(jobID)
		if readErr != nil || !present {
			log.Printf("Job %s: unknown terminal result unavailable for reconciliation: %v", jobID, readErr)
			return
		}
		log.Printf("Job %s: refusing automatic reprint of the original unknown outcome", jobID)
		if err := a.reportDurableTerminalResult(ctx, result); err != nil {
			log.Printf("Job %s: unknown outcome reconciliation failed: %v", jobID, err)
		}
		return
	}

	pl, err := payload.Parse(job["payload"])
	if err != nil {
		log.Printf("Job %s has an invalid payload: %v", jobID, err)
		a.updateJobStatus(ctx, jobID, "failed", fmt.Sprintf("invalid payload: %v", err), claimToken, "")
		return
	}

	kind := string(pl.Type)
	const identityConflict = "JOB_IDENTITY_MISMATCH: local durable record has another printer or payload; no bytes sent"

	log.Printf("Printing job %s on printer %s (%d bytes, type=%s, path=%s)", jobID, printerID, len(pl.Data), pl.Type, kind)

	// Persist the job while it waits for the per-printer mutex. Waiting for
	// hardware is NOT a physical attempt: marking it `printing` here caused
	// startup recovery to report UNKNOWN for jobs that never reached a device.
	// The in-flight job fence and per-printer mutex suppress duplicate live
	// deliveries. BeginPrint provides the durable physical-attempt fence only
	// after all local scheduling waits have completed.
	if err := a.queue.ReserveBeforeDispatch(jobID, printerID, pl.Data, claimToken); err != nil {
		if errors.Is(err, queue.ErrJobIdentityMismatch) {
			// This is NOT a transient ledger error: requeueing a mismatched
			// operation would repeat indefinitely, or could later print new
			// bytes under a job ID with old physical evidence.
			log.Printf("Job %s: local job identity mismatch; refusing a different printer or payload before hardware", jobID)
			if reportErr := a.updateJobStatus(ctx, jobID, "failed", identityConflict, claimToken, ""); reportErr != nil {
				log.Printf("Job %s: could not report immutable identity rejection: %v", jobID, reportErr)
			}
			return
		}
		log.Printf("Job %s: local durable pending row unavailable; refusing dispatch (no bytes sent): %v", jobID, err)
		a.rejectJob(ctx, jobID, claimToken, "ledger_unavailable")
		return
	}

	// Serialize Gateway aliases and bare local IDs on the same backend.
	// Admission must follow all local waits so TTL and lifecycle are checked
	// immediately before hardware, using the Gateway database clock.
	localPrinterID := a.resolvePrinterAlias(printerID)

	lock := a.getPrinterLock(localPrinterID)
	if !lockPrinterUntil(lock, ctx.Done()) {
		// ReserveBeforeDispatch persisted the fenced claim while the job was
		// waiting. Leave it queued for the startup/periodic hand-back outbox;
		// no physical attempt began and no live worker's mutex is disturbed.
		return
	}
	defer lock.Unlock()

	if ctx.Err() != nil {
		return
	}

	if !a.isPrinterExecutionAllowed(localPrinterID) {
		// A successful, exact Gateway hand-back is the sole authority to
		// clear the local queued claim. Retaining an ACKed token makes the
		// recovery outbox return an already-refunded attempt again; clearing
		// it on timeout would instead lose the original recovery fence.
		if err := a.rejectJob(ctx, jobID, claimToken, "printer_not_at_desired_state"); err == nil {
			if err := a.queue.ClearPreDispatchClaim(jobID, claimToken); err != nil {
				log.Printf("Job %s: desired-state pre-dispatch return acknowledged but local token clear failed: %v", jobID, err)
			}
		}
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
		reason := fmt.Sprintf("printer %s is not configured on this agent", printerID)
		_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}
	if !printer.SupportsKind(p, kind) {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s cannot print %s payloads", printerID, kind)
		_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}
	// resolvedImageGeometry carries the image geometry chosen by the
	// fallback policy below into the backend print call, so the backend
	// does not re-measure (and cannot re-fail) at print time.
	var resolvedImageGeometry *printer.Geometry
	facts, factsOK := a.deviceFacts(printerID)
	if !factsOK {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: printer %s has no declared device facts on this agent", printerID)
		_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}
	if kind == printer.KindImage {
		a.printersMu.RLock()
		pc := a.printerConfigs[printerID]
		a.printersMu.RUnlock()
		// Geometry policy: never refuse an image job merely because the
		// driver measurement is slow or failing, and never require the
		// rendered fingerprint to match a fresh measurement. Resolve in
		// preference order — background-cached geometry, bounded live
		// measurement, last known size, configured default profile — and
		// refuse only when no geometry exists anywhere (the resolver's
		// error states exactly that, with the measurement failure).
		geometry, geometryErr := a.resolveDispatchGeometry(ctx, printerID, p, pc, pl.GeometryFingerprint)
		if geometryErr != nil {
			reason := fmt.Sprintf("CAPABILITY_MISMATCH: %v", geometryErr)
			_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
			a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
			return
		}
		resolvedImageGeometry = geometry
		facts.Geometry = geometry
	}
	if compatible, why := printer.PayloadCompatibleForDevice(kind, pl.Protocol, facts); !compatible {
		reason := fmt.Sprintf("CAPABILITY_MISMATCH: %s", why)
		_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
		a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
		return
	}

	// This is a declaration of the route selected for this attempt. It is
	// evidence of configuration, not evidence of transport I/O or paper output.
	statusTransport := printStatusTransport(facts)

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
		// The durable row is only `queued`, not `printing`: no physical
		// attempt happened. Its claim token remains available for the
		// periodic fenced hand-back if the immediate rejection fails.
		a.rejectJob(ctx, jobID, claimToken, "agent_shutting_down")
		return
	}
	// Final dispatch fence after all scheduling waits, before the durable
	// physical-attempt transition. This is a local configuration check
	// only (identity collision, inventory absence, provable destination
	// change, mid-dispatch reconfiguration): it performs no live probe and
	// no driver measurement, so a slow or failing measurement can never
	// refuse the job here. Device truth is enforced by the physical
	// attempt itself, which reports the printer's own error reason.
	a.printersMu.RLock()
	verifiedConfig := a.printerConfigs[printerID]
	a.printersMu.RUnlock()
	if err := a.verifyPrinterForDispatch(ctx, printerID, p, verifiedConfig, fields.BindingDigest); err != nil {
		if posJob {
			log.Printf("Job %s (POS documentType=%q): pre-dispatch verification advisory (%v); degrading gracefully so POS printing is never blocked", jobID, fields.DocumentType, err)
		} else {
			reason := fmt.Sprintf("%v; zero output bytes transmitted", err)
			_ = a.queue.UpdateStatusWithError(jobID, "failed", reason)
			a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
			return
		}
	}

	// With the printer lock and execution slot held, this attempt is now
	// eligible for physical execution. Persist the claim-fenced printing
	// transition BEFORE the first hardware byte (never after) so a crash
	// beyond this boundary conservatively remains UNKNOWN.
	ledgerStart := time.Now()
	// The durable ledger reservation used the exact Gateway printer ID before
	// resolving the local alias. Preserve that same immutable ID here; the
	// physical backend still uses the validated local printer ID above.
	if err := a.queue.BeginPrint(jobID, fields.PrinterID, pl.Data, claimToken, false); err != nil {
		if errors.Is(err, queue.ErrAlreadyPrinting) {
			log.Printf("Job %s: duplicate delivery for the live local claim; suppressing a second physical dispatch", jobID)
			return
		}
		if errors.Is(err, queue.ErrTerminalState) {
			log.Printf("Job %s: local ledger is terminal; refusing dispatch and re-reporting stored outcome", jobID)
			result, present, getErr := a.queue.TerminalResultFor(jobID)
			if getErr == nil && present {
				getErr = a.reportDurableTerminalResult(ctx, result)
			}
			if getErr != nil || !present {
				log.Printf("Job %s: original terminal reconciliation unavailable: %v", jobID, getErr)
			}
			return
		}
		if errors.Is(err, queue.ErrJobIdentityMismatch) {
			log.Printf("Job %s: local job identity changed after reservation; refusing physical execution", jobID)
			if reportErr := a.updateJobStatus(ctx, jobID, "failed", identityConflict, claimToken, ""); reportErr != nil {
				log.Printf("Job %s: could not report immutable identity rejection: %v", jobID, reportErr)
			}
			return
		}
		log.Printf("Job %s: local durable ledger unavailable; refusing dispatch (no bytes sent): %v", jobID, err)
		a.rejectJob(ctx, jobID, claimToken, "ledger_unavailable")
		return
	}
	log.Printf("print.trace local_ledger_ready request_id=%s job_id=%s printer_id=%s ledger_latency_ms=%d", requestID, jobID, printerID, time.Since(ledgerStart).Milliseconds())

	reportStart := time.Now()
	if err := a.reportPrintingWithRetry(ctx, jobID, claimToken, statusTransport); err != nil {
		// Context cancellation is an authoritative local lifecycle signal, not
		// a generic odoo transport failure. Never use the stale-claim
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
			if posJob && !errors.Is(err, ErrStaleClaim) && !errors.Is(err, ErrJobCanceled) {
				log.Printf("Job %s (POS documentType=%q): printing status sync failed (%s: %v); degrading gracefully and proceeding to printer", jobID, fields.DocumentType, reason, err)
			} else {
				log.Printf("Job %s: physical dispatch refused (%s); aborting before any byte is sent", jobID, reason)
				if aberr := a.queue.AbortPrint(jobID, "dispatch_refused: "+reason+"; zero bytes transmitted"); aberr != nil {
					log.Printf("Job %s: failed to abort local ledger row: %v", jobID, aberr)
				}
				return
			}
		}
	}
	log.Printf("print.trace printing_report request_id=%s job_id=%s printer_id=%s report_latency_ms=%d", requestID, jobID, printerID, time.Since(reportStart).Milliseconds())

	// Only the physical execution phase gets a document-specific timeout.
	printCtx, cancel := context.WithTimeout(ctx, printDocumentTimeout(len(pl.Data)))
	defer cancel()
	if resolvedImageGeometry != nil {
		printCtx = printer.WithDispatchGeometry(printCtx, resolvedImageGeometry)
	}
	printCtx = printer.WithDispatchAdmission(printCtx, func(admissionCtx context.Context) error {
		if a.fencedForDispatch() || !a.isPrinterExecutionAllowed(localPrinterID) {
			return fmt.Errorf("dispatch refused: agent or printer configuration changed before this transport submission")
		}
		if err := a.verifyPrinterForDispatch(admissionCtx, printerID, p, verifiedConfig, fields.BindingDigest); err != nil {
			if posJob {
				log.Printf("Job %s (POS documentType=%q): admission verification advisory (%v); degrading gracefully so POS printing is never blocked", jobID, fields.DocumentType, err)
			} else {
				return fmt.Errorf("dispatch refused before first output: %w", err)
			}
		}
		// The bounded claim ACK is itself a wait. A local unshare during that
		// request must still fence native creation/first bytes on its return.
		if a.fencedForDispatch() || !a.isPrinterExecutionAllowed(localPrinterID) {
			return fmt.Errorf("dispatch refused: local printer admission changed while acknowledging the claim")
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
	effectiveProtocol := strings.ToLower(strings.TrimSpace(pl.Protocol))
	if effectiveProtocol == "" {
		effectiveProtocol = strings.ToLower(strings.TrimSpace(facts.Protocol))
	}
	if hasActivePeripherals {
		profile := printer.PeripheralProfile{
			DrawerKickMode: pl.Peripherals.Drawer,
			CutterMode:     pl.Peripherals.Cutter,
			BuzzerMode:     pl.Peripherals.Buzzer,
		}
		// Insert a 150ms delay between cash drawer solenoid triggers and thermal print heads
		// to prevent microcontroller brownouts on 24V power adapters.
		if (pl.Peripherals.Drawer == "pin2" || pl.Peripherals.Drawer == "pin5") && effectiveProtocol == "escpos" {
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
					if err := a.queue.UpdateStatusWithError(jobID, "failed", reason); err != nil {
						log.Printf("Job %s: ledger write failed after ambiguous drawer kick: %v", jobID, err)
						a.rememberTerminalExecution(jobID, "failed", reason, claimToken, "")
					}
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
			settle := time.NewTimer(150 * time.Millisecond)
			select {
			case <-printCtx.Done():
				settle.Stop()
				reason := "UNKNOWN_PARTIAL_DELIVERY: cash-drawer kick succeeded but the print attempt was cancelled before the main document dispatch"
				if err := a.queue.UpdateStatusWithError(jobID, "failed", reason); err != nil {
					log.Printf("Job %s: ledger write failed after post-drawer cancellation: %v", jobID, err)
					a.rememberTerminalExecution(jobID, "failed", reason, claimToken, "")
				}
				a.updateJobStatus(ctx, jobID, "failed", reason, claimToken, "")
				return
			case <-settle.C:
			}
			profile.DrawerKickMode = "none"
		}
		// For image jobs (JPEG), wrapping raw JPEG bytes with ESC/POS buzzer/cutter
		// corrupts the JPEG header or gets stripped by jpeg.Decode. Defer wrapping
		// to prepareESCPOSImageMode right after JPEG-to-ESC/POS rasterization.
		if kind != printer.KindImage {
			printData = printer.WrapPeripheralCommands(printData, pl.Protocol, profile)
		}
	}
	printStart := time.Now()
	log.Printf("print.trace render_transport_start request_id=%s job_id=%s printer_id=%s local_execution_ms=%d payload_bytes=%d kind=%s", requestID, jobID, printerID, time.Since(receivedAt).Milliseconds(), len(printData), kind)
	// Persist platform submission evidence DURING the printing phase, not
	// only with the terminal result: a crash between StartDoc (identity
	// allocated) and the terminal ledger write must not lose the only
	// durable link to the platform job. The observer stops when dispatch
	// returns; the terminal path remains authoritative.
	document := documentForClaimedJob(fields, kind, printData)
	document.GeometryFingerprint = pl.GeometryFingerprint
	if hasActivePeripherals && kind == printer.KindImage && effectiveProtocol == "escpos" {
		imgPeriph := printer.PeripheralProfile{
			DrawerKickMode: "none",
			CutterMode:     pl.Peripherals.Cutter,
			BuzzerMode:     pl.Peripherals.Buzzer,
		}
		document.Peripherals = &imgPeriph
	}
	spoolerJobID, printErr := a.dispatchDocumentWithEvidence(printCtx, jobID, p, document)
	log.Printf("print.trace transport_complete request_id=%s job_id=%s printer_id=%s transport_latency_ms=%d success=%t", requestID, jobID, printerID, time.Since(printStart).Milliseconds(), printErr == nil)

	// Capture platform submission evidence for this attempt regardless of the
	// terminal result. Windows can allocate a spool job before a later write or
	// render error, and that identity is essential for safe reconciliation.
	failureMsg := ""
	if printErr != nil {
		failureMsg = printErr.Error()
		// Belt and braces: if the transport chain proved an ambiguous
		// physical outcome but lost the marker through wrapping, restore it
		// here so the odoo can NEVER classify this as safely retryable.
		if printer.OutcomeUnknown(printErr) && !printer.HasUnknownOutcomeMarker(failureMsg) {
			failureMsg = "UNKNOWN_PARTIAL_DELIVERY: " + failureMsg
		}
		if physicalPeripheralSideEffect && !printer.HasUnknownOutcomeMarker(failureMsg) {
			failureMsg = "UNKNOWN_PARTIAL_DELIVERY: peripheral side effect succeeded before main print outcome was known: " + failureMsg
		}
		if err := a.queue.UpdateTerminalResult(jobID, "failed", failureMsg, spoolerJobID, statusTransport, ""); err != nil {
			log.Printf("Job %s: ledger write failed after print failure: %v", jobID, err)
			// Physical execution already happened (or is ambiguous). If the
			// durable terminal row cannot be written, keep an in-process fence
			// including any platform identity so duplicate delivery cannot
			// execute the printer again and later reconciliation keeps its evidence.
			a.rememberTerminalOutput(jobID, "failed", failureMsg, claimToken, spoolerJobID, statusTransport)
		}
	} else {
		if err := a.queue.UpdateTerminalResult(jobID, "success", "", spoolerJobID, statusTransport, ""); err != nil {
			// Physical execution already succeeded. If SQLite cannot persist
			// the terminal row, keep an in-process fence INCLUDING the platform
			// job identity so a lost Gateway acknowledgement can be re-reported
			// without executing the printer again. On restart, a durable row that
			// remained `printing` is converted to an explicit unknown outcome.
			log.Printf("Job %s: ledger write failed after successful print: %v", jobID, err)
			a.rememberTerminalOutput(jobID, "success", "", claimToken, spoolerJobID, statusTransport)
		}
	}

	if printErr != nil {
		log.Printf("Job %s FAILED on printer %s: %v", jobID, printerID, printErr)
		if err := a.updateJobStatusWithTransport(ctx, jobID, "failed", failureMsg, claimToken, spoolerJobID, statusTransport); err != nil {
			if errors.Is(err, ErrStaleClaim) || errors.Is(err, ErrJobCanceled) {
				log.Printf("Job %s: terminal failure already settled on server (%v); clearing local outbox token", jobID, err)
				_ = a.queue.ClearClaimToken(jobID, claimToken)
			}
		}
		return
	}

	log.Printf("Job %s: payload transmitted successfully to printer %s", jobID, printerID)
	// Surface the platform job identity (Windows spooler) when the backend
	// reports one for this dispatch. Non-publishing backends return "", so
	// this stays a no-op off Windows and the Gateway contract is unchanged.
	// WP2: run the bounded submission verification before reporting
	// success. v4 ships no live GetJob/Get-Job-Attributes adapter (none
	// exists in the tree), so the query is nil and the report carries
	// submission-source evidence; the Gateway therefore derives
	// 'submitted', never 'completed', until a query adapter lands.
	submissionEvidence := printer.VerifySubmission(ctx, nil)
	submissionEvidence.Transport = statusTransport
	submissionEvidence.SpoolerJobID = spoolerJobID
	if err := a.updateJobStatusWithSubmissionEvidence(ctx, jobID, "success", "", claimToken, spoolerJobID, statusTransport, &submissionEvidence); err != nil {
		if errors.Is(err, ErrStaleClaim) || errors.Is(err, ErrJobCanceled) {
			log.Printf("Job %s: LATE_SUCCESS_POST_EXPIRATION or terminal settlement on Gateway (%v); clearing local outbox token", jobID, err)
			_ = a.queue.ClearClaimToken(jobID, claimToken)
		} else {
			log.Printf("Job %s: terminal success report deferred to outbox: %v", jobID, err)
		}
	}
}

// dispatchDocumentWithEvidence gives the worker, observer and terminal path
// one invocation-owned evidence scope. Never read a reusable backend's last ID
// here: dispatch may fail before acquiring its session. The deferred join also
// stops the observer if a backend panics and the outer execution fence recovers.
func (a *Agent) dispatchDocumentWithEvidence(ctx context.Context, jobID string, p printer.Printer, doc printer.Document) (spoolerJobID string, printErr error) {
	printCtx, evidence := printer.WithSpoolerJobEvidence(ctx)
	stop := a.watchSpoolerJobID(jobID, evidence)
	defer func() {
		stop()
		spoolerJobID = evidence.Close()
	}()
	printErr = printer.PrintDocument(printCtx, p, doc)
	return
}

// watchSpoolerJobID persists only the current invocation's platform allocation
// during dispatch. The returned closure joins the observer before the terminal
// snapshot/write. SQLite failures are retried on later polls and at stop time;
// this is best-effort early persistence, not an atomic native/SQLite commit.
func (a *Agent) watchSpoolerJobID(jobID string, evidence *printer.SpoolerJobEvidence) (stop func()) {
	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		record := func() bool {
			if id := evidence.SpoolerJobID(); id != "" {
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
					// only repeat the same write, but retrying also covers
					// transient persistence failures. The stop-time read
					// gives terminal handoff one final opportunity.
				}
			}
		}
	}()
	return func() {
		close(stopCh)
		<-done
	}
}

// ErrStaleClaim is returned by updateJobStatus when the odoo rejects a
// status report at the claim fence (HTTP 409/410 or a STALE_CLAIM /
// FENCE_REJECTED payload): this attempt no longer owns the job. processJob
// treats it as a HARD STOP before any byte reaches the printer.
var ErrStaleClaim = errors.New("odoo rejected claim fence: stale or reclaimed token")

// ErrTransitionRejected is returned by updateJobStatus when the odoo
// answers a status report with an explicit non-fence rejection (any other
// 4xx/5xx). Unlike a transport error, this IS authoritative: the odoo
// evaluated our transition and refused it, so physical dispatch must stop.
var ErrTransitionRejected = errors.New("odoo rejected status transition")

// ErrJobCanceled is returned by updateJobStatus when the odoo reports
// JOB_ALREADY_CANCELED (v4): an operator canceled the job, or its 24h
// claimed-cancel reconciliation window closed. Like ErrStaleClaim it is a
// HARD STOP for dispatch, and for terminal re-reports it means the
// Gateway has settled the job: the local outbox entry must be dropped
// (see reportDurableTerminalResult), never retried, never re-executed.
var ErrJobCanceled = errors.New("odoo reports job canceled by operator")

func (a *Agent) updateJobStatus(ctx context.Context, jobID, status, errMsg, claimToken, spoolerJobID string, reason ...string) error {
	return a.updateJobStatusWithTransport(ctx, jobID, status, errMsg, claimToken, spoolerJobID, "", reason...)
}

// updateJobStatusWithTransport adds optional route diagnostics to the existing
// status contract. Empty transport is intentionally omitted for legacy/replay
// call sites with no verified local printer facts.
func (a *Agent) updateJobStatusWithTransport(ctx context.Context, jobID, status, errMsg, claimToken, spoolerJobID, transport string, reason ...string) error {
	return a.updateJobStatusWithSubmissionEvidence(ctx, jobID, status, errMsg, claimToken, spoolerJobID, transport, nil, reason...)
}

// updateJobStatusWithSubmissionEvidence is updateJobStatusWithTransport
// plus the WP2 submission-evidence field. The evidence is additive and
// optional: older Gateway versions ignore unknown fields, and a nil
// evidence value omits the field entirely (old behavior preserved).
func (a *Agent) updateJobStatusWithSubmissionEvidence(ctx context.Context, jobID, status, errMsg, claimToken, spoolerJobID, transport string, submission *printer.SubmissionEvidence, reason ...string) error {
	// The caller owns this immutable attempt token; never substitute a newer delivery.
	reqURL := "/api/agent/ack"
	body := map[string]interface{}{
		"jobId":  jobID,
		"status": status,
		"error":  errMsg,
	}
	if claimToken != "" {
		body["claimToken"] = claimToken
	}
	if transport != "" {
		body["transport"] = transport
	}
	// Spooler evidence is additive and optional: older Gateway versions
	// ignore unknown fields, and printers without a platform identity
	// (network/USB/IPP, non-Windows stub) report "" and omit it.
	if spoolerJobID != "" {
		body["spoolerJobId"] = spoolerJobID
	}
	// WP2 submission evidence is additive and optional on the same terms.
	// It is only ever attached to a success report by the caller; the
	// Gateway rejects it on any other report with 422.
	if submission != nil {
		body["submissionEvidence"] = submission
	}
	if len(reason) > 0 && reason[0] != "" {
		body["reason"] = reason[0]
	}
	resp, err := a.doAuthorizedRequest(ctx, "POST", reqURL, body)
	if err != nil {
		log.Printf("Job %s: failed to report status %q to server: %v", jobID, status, err)
		return err
	}
	defer drainAndCloseBody(resp.Body)
	if resp.StatusCode >= 300 {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxGatewayErrorBodyBytes))
		if readErr != nil {
			log.Printf("Job %s: failed to read status rejection body: %v", jobID, readErr)
		}
		log.Printf("Job %s: server rejected status update to %q (%d): %s", jobID, status, resp.StatusCode, string(respBody))
		// Fence rejection: the odoo no longer recognizes this claim
		// (expired and reassigned, or never valid). Callers MUST treat this
		// as authoritative - especially the claimed->printing transition,
		// which must never proceed to hardware afterwards.
		if strings.Contains(string(respBody), "JOB_ALREADY_CANCELED") {
			return fmt.Errorf("%w: job %s status %q rejected as canceled (%d)", ErrJobCanceled, jobID, status, resp.StatusCode)
		}
		if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusGone ||
			strings.Contains(string(respBody), "STALE_CLAIM") || strings.Contains(string(respBody), "FENCE_REJECTED") {
			return fmt.Errorf("%w: job %s status %q rejected (%d)", ErrStaleClaim, jobID, status, resp.StatusCode)
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= http.StatusInternalServerError {
			return fmt.Errorf("odoo transient status error for %q (%d): %s", status, resp.StatusCode, string(respBody))
		}
		return fmt.Errorf("%w to %q (%d): %s", ErrTransitionRejected, status, resp.StatusCode, string(respBody))
	}
	if status == "printing" || status == "success" || status == "failed" || status == "unknown" || status == "queued" {
		var accepted struct {
			OK      bool   `json:"ok"`
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
		if !(accepted.OK || accepted.Success) || accepted.Status != status {
			return fmt.Errorf("%w: Odoo did not acknowledge %q (status %q)", ErrTransitionRejected, status, accepted.Status)
		}
	}
	if status == "success" || status == "failed" || status == "unknown" {
		if err := a.queue.ClearClaimToken(jobID, claimToken); err != nil {
			// The Gateway already acknowledged the terminal outcome; retain the
			// local token if SQLite cleanup fails so a later scan can retry the
			// harmless cleanup without reprinting.
			log.Printf("Job %s: Odoo acknowledged terminal status %q but local report token cleanup failed: %v", jobID, status, err)
		}
	}
	return nil
}

func (a *Agent) doAuthorizedRequest(ctx context.Context, method, endpointPath string, body interface{}) (*http.Response, error) {
	target, err := config.OdooEndpoint(a.cfg.Server.URL, endpointPath)
	if err != nil {
		return nil, fmt.Errorf("invalid Odoo endpoint: %w", err)
	}
	var buf io.Reader
	if body != nil {
		b, err := marshalAgentJSON(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		buf = bytes.NewReader(b)
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

func marshalAgentJSON(value interface{}) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// Application JSON is not rendered as HTML; keep wire size aligned with Gateway accounting.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

// SetLicenseGuard replaces the agent's runtime license guard (used by startup wiring and tests).
func (a *Agent) SetLicenseGuard(g *license.RuntimeGuard) {
	a.licenseGuard = g
}

func (a *Agent) applyOdooLicense(raw json.RawMessage, odooDBUUID, source string) {
	if a.licenseGuard == nil {
		return
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return
	}
	claims, inGrace, err := a.licenseGuard.ApplyBundle(trimmed, strings.TrimSpace(odooDBUUID), time.Now().UTC())
	if err != nil {
		log.Printf("[license:%s] bundle rejected: %v", source, err)
		return
	}
	if inGrace {
		log.Printf("[license:%s] license %s (rev %d) is in grace period; renew subscription soon", source, claims.LicenseID, claims.Rev)
	}
}

type wsServerFrame struct {
	Type          string          `json:"type"`
	Event         string          `json:"event"`
	Reason        string          `json:"reason"`
	PendingJobs   int             `json:"pendingJobs"`
	LicenseBundle json.RawMessage `json:"licenseBundle"`
	OdooDBUUID    string          `json:"odooDbUuid"`
}

// runOdooWebSocket maintains a persistent RFC 6455 WebSocket connection to Odoo
// (/api/agent/ws) with jittered exponential backoff (2s..60s). When unavailable,
// the Run() loop seamlessly continues with HTTP polling fallback.
func (a *Agent) runOdooWebSocket(ctx context.Context) {
	if a.cfg == nil || strings.TrimSpace(a.cfg.Server.URL) == "" {
		return
	}
	const (
		minBackoff = 2 * time.Second
		maxBackoff = 60 * time.Second
	)
	backoff := minBackoff

	for {
		if ctx.Err() != nil {
			return
		}
		token := fmt.Sprintf("%s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret)
		ws, err := dialOdooWS(ctx, a.cfg.Server.URL, a.cfg.Agent.ID, token)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, errWSUnauthorized) {
				a.fenceForCredentialRejection("odoo ws 401")
				backoff = maxBackoff
			}
			log.Printf("[ws] connect to Odoo failed (HTTP polling fallback active): %v", err)
		} else {
			log.Printf("[ws] connected to Odoo push channel")
			backoff = minBackoff

			connCtx, connCancel := context.WithCancel(ctx)
			pingDone := make(chan struct{})
			go func() {
				defer close(pingDone)
				ticker := time.NewTicker(wsPingInterval)
				defer ticker.Stop()
				for {
					select {
					case <-connCtx.Done():
						return
					case <-ticker.C:
						if pingErr := ws.WritePing([]byte("ping")); pingErr != nil {
							_ = ws.Close()
							return
						}
					}
				}
			}()

			// Close the socket immediately if parent ctx cancels so ReadMessage (and any
			// blocked WritePing) unblock without stalling behind wsWriteTimeout.
			closeWatcherDone := make(chan struct{})
			go func() {
				defer close(closeWatcherDone)
				select {
				case <-ctx.Done():
					_ = ws.Close()
				case <-connCtx.Done():
				}
			}()

			a.wsConnected.Store(true)
		readLoop:
			for {
				op, msg, readErr := ws.ReadMessage()
				if readErr != nil {
					a.wsConnected.Store(false)
					if ctx.Err() == nil {
						log.Printf("[ws] disconnected from Odoo (reconnecting): %v", readErr)
					}
					break
				}
				if op != wsOpText || len(msg) == 0 {
					continue
				}
				var ev wsServerFrame
				if unmarshalErr := json.Unmarshal(msg, &ev); unmarshalErr != nil {
					continue
				}
				evType := ev.Type
				if evType == "" {
					evType = ev.Event
				}
				switch evType {
				case "welcome", "license_update":
					a.applyOdooLicense(ev.LicenseBundle, ev.OdooDBUUID, "ws:"+evType)
					if evType == "welcome" && ev.PendingJobs > 0 && a.wsWakeCh != nil {
						select {
						case a.wsWakeCh <- struct{}{}:
						default:
						}
					}
				case "agent_revoked":
					reason := strings.TrimSpace(ev.Reason)
					if reason == "" {
						reason = "agent_revoked"
					}
					a.fenceForCredentialRejection("odoo ws " + reason)
					backoff = maxBackoff
					_ = ws.Close()
					break readLoop
				case "job_available":
					if a.wsWakeCh != nil {
						select {
						case a.wsWakeCh <- struct{}{}:
						default:
						}
					}
				}
			}

			connCancel()
			_ = ws.Close()
			<-pingDone
			<-closeWatcherDone
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(jitteredBackoff(backoff)):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}
