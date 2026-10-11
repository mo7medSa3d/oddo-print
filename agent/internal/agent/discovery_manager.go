package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// maxDiscoverySessionsBytes bounds the pending-session list: sessions are
// metadata only (no printer payloads), and the gateway runs at most one
// session per agent, so this is a hard ceiling far above any real response.
const maxDiscoverySessionsBytes = 8 << 20

const (
	defaultDiscoveryTimeout = 30 * time.Second
	minDiscoveryTimeout     = 500 * time.Millisecond
	maxDiscoveryTimeout     = 30 * time.Second
)

// pollDiscovery checks gateway for pending discovery sessions for this agent and executes them.
func (a *Agent) pollDiscovery(ctx context.Context) {
	reqURL := "/api/agent/discovery"
	resp, err := a.doAuthorizedRequest(ctx, "GET", reqURL, nil)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	sessions, err := decodeBoundedGatewayList(resp.Body, maxDiscoverySessionsBytes, 5)
	if err != nil {
		log.Printf("[discovery] failed to decode pending sessions: %v", err)
		return
	}
	for index, s := range sessions {
		rawID, exists := s["id"]
		if !exists || rawID == nil {
			log.Printf("[discovery] rejecting session %d: missing id", index)
			continue
		}
		id, ok := rawID.(string)
		if !ok || strings.TrimSpace(id) == "" {
			log.Printf("[discovery] rejecting session %d: id must be a non-empty string", index)
			continue
		}
		// At most one discovery session runs at a time (full bounded LAN
		// scan). A pending session expires on the gateway in 60s and each
		// run is bounded to 30s, so anything skipped here is simply picked
		// up on the next 30s poll tick — no goroutine pile-up.
		select {
		case a.discoverySem <- struct{}{}:
			session := s
			a.launchTracked(func() {
				a.executeDiscoverySession(ctx, id, session)
			})
		default:
			// Polling sees the same running session as the WS trigger. A busy
			// semaphore is deferral, not cancellation of the worker that owns it.
			log.Printf("[discovery] session %s deferred: a discovery session is already running", id)
		}
	}
}

func loadDiscoverySessionByID(ctx context.Context, doRequest func(context.Context) (*http.Response, error), discoveryID string) map[string]interface{} {
	if discoveryID == "" {
		return nil
	}
	resp, err := doRequest(ctx)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	sessions, err := decodeBoundedGatewayList(resp.Body, maxDiscoverySessionsBytes, 5)
	if err != nil {
		log.Printf("[discovery] failed to decode session lookup response: %v", err)
		return nil
	}
	for index, session := range sessions {
		rawID, exists := session["id"]
		if !exists || rawID == nil {
			log.Printf("[discovery] rejecting session %d during lookup: missing id", index)
			continue
		}
		id, ok := rawID.(string)
		if !ok || strings.TrimSpace(id) == "" {
			log.Printf("[discovery] rejecting session %d during lookup: id must be a non-empty string", index)
			continue
		}
		if id == discoveryID {
			return session
		}
	}
	return nil
}

func (a *Agent) loadDiscoverySession(ctx context.Context, discoveryID string) map[string]interface{} {
	reqURL := "/api/agent/discovery"
	doRequest := func(callCtx context.Context) (*http.Response, error) {
		return a.doAuthorizedRequest(callCtx, http.MethodGet, reqURL, nil)
	}
	return loadDiscoverySessionByID(ctx, doRequest, discoveryID)
}

// discoveryScanFunc runs one discovery pass and reports incremental progress.
type discoveryScanFunc func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult

// runBoundedDiscovery separates orchestration lifetime from an underlying
// discovery call that may be synchronous/uncancellable at the OS boundary.
// The caller gets a bounded result while finishedCh remains the sole signal used
// to release ownership of the worker/semaphore.
//
// An expired bound no longer discards the scan. Windows sources such as
// EnumPrintersW are synchronous and cannot be interrupted by a Go context, so a
// single slow source used to take every other source's findings down with it:
// the empty result meant nothing was persisted locally and the Gateway was told
// the session had produced zero devices. The scan now publishes progress
// snapshots, so the sources that did finish are preserved and reported as a
// partial result. Absence is still never reconciled as removal, because
// CompleteSources records exactly which sources proved an inventory.
func runBoundedDiscovery(ctx context.Context, max time.Duration, discover discoveryScanFunc) (printer.DiscoveryResult, bool, <-chan struct{}) {
	boundedCtx, cancel := context.WithTimeout(ctx, max)
	defer cancel()
	resultCh := make(chan printer.DiscoveryResult, 1)
	finishedCh := make(chan struct{})

	var (
		partialMu sync.Mutex
		partial   printer.DiscoveryResult
	)
	onProgress := func(r printer.DiscoveryResult) {
		partialMu.Lock()
		partial = r
		partialMu.Unlock()
	}

	go func() {
		defer close(finishedCh)
		resultCh <- discover(boundedCtx, onProgress)
	}()

	select {
	case result := <-resultCh:
		return result, true, finishedCh
	case <-boundedCtx.Done():
		partialMu.Lock()
		truncated := partial
		partialMu.Unlock()
		if truncated.Printers == nil {
			// No source had produced anything yet: nothing was learned, so
			// there is no partial inventory to report.
			return printer.DiscoveryResult{}, false, finishedCh
		}
		truncated.Truncated = true
		truncated.Errors = append(truncated.Errors,
			fmt.Sprintf("discovery exceeded the %s bound; the result is partial and absence was not reconciled as removal", max))
		// Report as a bounded (not failed) run so the partial inventory is
		// persisted and published instead of thrown away.
		return truncated, true, finishedCh
	}
}

func discoverySessionTimeout(session map[string]interface{}) time.Duration {
	config, ok := session["config"].(map[string]interface{})
	if !ok {
		return defaultDiscoveryTimeout
	}
	raw, ok := config["timeoutMs"]
	if !ok {
		return defaultDiscoveryTimeout
	}
	var ms int64
	switch value := raw.(type) {
	case float64:
		ms = int64(value)
	case int:
		ms = int64(value)
	case int64:
		ms = value
	default:
		return defaultDiscoveryTimeout
	}
	if ms < int64(minDiscoveryTimeout/time.Millisecond) {
		ms = int64(minDiscoveryTimeout / time.Millisecond)
	}
	if ms > int64(maxDiscoveryTimeout/time.Millisecond) {
		ms = int64(maxDiscoveryTimeout / time.Millisecond)
	}
	return time.Duration(ms) * time.Millisecond
}

// releaseDiscoverySemaphoreWhenFinished transfers semaphore cleanup to an
// untracked waiter. The underlying detector may be stuck in synchronous OS
// I/O that cannot be cancelled by a Go context; holding the semaphore prevents
// overlapping scans, while keeping the waiter out of runtimeWG lets process
// shutdown complete.
func (a *Agent) releaseDiscoverySemaphoreWhenFinished(finished <-chan struct{}) {
	go func() {
		<-finished
		<-a.discoverySem
	}()
}

func (a *Agent) executeDiscoverySession(ctx context.Context, discoveryID string, session map[string]interface{}) {
	log.Printf("[discovery] executing session %s", discoveryID)

	// Enforce a hard orchestration bound even though individual detectors have
	// their own shorter network timeouts. The result channel is buffered so a
	// detector that finishes just after cancellation cannot block forever.
	discoveryTimeout := discoverySessionTimeout(session)
	log.Printf("[discovery] session %s using Gateway timeout %s", discoveryID, discoveryTimeout)
	discoveryCtx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()

	result, completed, finishedCh := runBoundedDiscovery(discoveryCtx, discoveryTimeout, func(scanCtx context.Context, onProgress printer.DiscoveryProgressFunc) printer.DiscoveryResult {
		return printer.DiscoverLiveWithProgress(scanCtx, a.cfg, a.registryPath, onProgress)
	})
	if !completed {
		status := "failed"
		if discoveryCtx.Err() == context.Canceled {
			status = "cancelled"
		}
		log.Printf("[discovery] session %s exceeded %s bound: %v", discoveryID, discoveryTimeout, discoveryCtx.Err())
		a.reportDiscoveryResult(ctx, discoveryID, status, nil)
		// Do not release the discovery semaphore until the underlying scan has
		// actually returned. This matters on Windows because EnumPrintersW is
		// synchronous and does not accept Go context cancellation. At most one
		// such blocked scan can exist, so cancellation cannot create an
		// unbounded goroutine/worker leak.
		a.releaseDiscoverySemaphoreWhenFinished(finishedCh)
		return
	}

	// A manager-triggered scan is also an authoritative local inventory
	// opportunity. Persist runnable observations and reconcile only sources
	// that completed authoritatively; candidate-only evidence remains report
	// data and a partial source can never delete existing local inventory.
	if merged, persistErr := a.persistLiveDiscovery(result); persistErr != nil {
		result.Errors = append(result.Errors, "registry persistence: "+persistErr.Error())
	} else {
		a.reconcileRegistryPrinters(merged)
	}

	devices := make([]map[string]interface{}, 0, len(result.Printers))
	for _, di := range result.Printers {
		devices = append(devices, discoveryDevicePayload(a.cfg.Agent.ID, di))
	}

	status := "completed"
	switch {
	case result.Truncated && len(devices) > 0:
		// The bound expired after sources had produced observations. The
		// inventory is real but incomplete, so it is published as partial
		// rather than discarded as a failure.
		status = "partial"
	case result.Truncated:
		// Nothing was learned before the bound expired.
		status = "failed"
	case len(result.Errors) > 0 && len(devices) > 0:
		status = "partial"
	case len(result.Errors) > 0:
		status = "failed"
	}
	if result.Truncated {
		log.Printf("[discovery] session %s ended bounded: reporting %d devices from completed sources only", discoveryID, len(devices))
	}

	a.reportDiscoveryResult(ctx, discoveryID, status, devices, result.Errors)
	if result.Truncated {
		// The bound expired but the underlying scan is still blocked in a
		// synchronous Win32 call. Hold the one-scan-at-a-time semaphore until
		// that worker actually returns, exactly as the failure path does, so a
		// new session cannot overlap it.
		a.releaseDiscoverySemaphoreWhenFinished(finishedCh)
		return
	}
	<-a.discoverySem
}

// boundedDiscoveryText counts UTF-16 units to match the Gateway's string limits.
func boundedDiscoveryText(value string, max int) string {
	units := 0
	for index, r := range value {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if units+n > max {
			return value[:index]
		}
		units += n
	}
	return value
}

func discoveryDevicePayload(agentID string, di printer.DeviceInfo) map[string]interface{} {
	sources := []string{}
	if v, ok := di.Capabilities["discovered_via"].(string); ok && v != "" {
		sources = append(sources, boundedDiscoveryText(v, 64))
	}
	protocol := strings.TrimSpace(di.Protocol)
	if protocol == "" {
		protocol = "unknown"
	}
	verification := discoveryVerification(di)
	confidence := "low"
	if verification == "verified" {
		confidence = "medium"
	}
	dev := map[string]interface{}{
		"id": discoveryDeviceID(agentID, di.ID), "stableId": di.ID,
		"source": sources, "protocol": protocol,
		"deviceName":  boundedDiscoveryText(di.Name, 255),
		"deviceClass": normalizeDeviceClass(di.PrinterType),
		"transport":   di.ConnectionType, "model": boundedDiscoveryText(di.Name, 255),
		"confidence": confidence, "verification": verification,
		"rawMetadata": map[string]interface{}{"endpoint": di.Endpoint, "connectionType": di.ConnectionType},
	}
	if di.NetworkAddress != "" {
		dev["ipAddress"] = di.NetworkAddress
	}
	if di.Port > 0 && di.Port <= 65535 {
		dev["port"] = di.Port
	}
	if (protocol == "ipp" || protocol == "ipps") && di.Endpoint != "" {
		dev["uri"] = di.Endpoint
	}
	if di.SpoolerName != "" {
		dev["spoolerName"] = di.SpoolerName
	}
	if di.Capabilities != nil {
		dev["capabilities"] = di.Capabilities
		if manufacturer, ok := di.Capabilities["manufacturer"].(string); ok && manufacturer != "" {
			dev["manufacturer"] = boundedDiscoveryText(manufacturer, 120)
		}
		if model, ok := di.Capabilities["model"].(string); ok && model != "" {
			dev["model"] = boundedDiscoveryText(model, 255)
		}
	}
	return dev
}

func discoveryVerification(di printer.DeviceInfo) string {
	// Manager discovery may expose evidence the local Agent deliberately does
	// not promote to its runnable inventory. Never label such evidence
	// "verified" merely because WSD/SNMP/mDNS answered; executable transport
	// capability is a separate requirement.
	if !printer.IsRuntimeDiscoveryPrinter(di) {
		return "candidate"
	}
	verification := "candidate"
	if di.ConnectionType == "spooler" {
		verification = "verified"
	}
	if di.Capabilities != nil {
		if v, ok := di.Capabilities["ipp_verified"].(bool); ok && v {
			verification = "verified"
		}
		if v, ok := di.Capabilities["snmp_verified"].(bool); ok && v {
			verification = "verified"
		}
		// Historical mdns_verified is not independent transport proof:
		// pre-fix agents set it on receipt of a DNS-SD advertisement.
		// Only ipp_verified (a completed Get-Printer-Attributes exchange)
		// can promote IPP discovery above candidate here.
	}
	// WSD is discovery evidence only. A stale capability emitted by an older
	// agent must never elevate a device to routable/verified status by itself.
	return verification
}

func discoveryDeviceID(agentID, stableID string) string {
	key := "agent-discovery:" + agentID + ":" + stableID
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("dev_%x", h[:16])
}

// A single LAN scan can cover multiple network sources and installed queues.
// Gateway intentionally limits each Agent report to 1000 devices and 2 MiB;
// submitting all observations in one POST loses otherwise valid discovery
// results when a busy LAN crosses either limit. Split at a much smaller bound
// and finish only after every earlier page was acknowledged. The Gateway
// records numbered chunks idempotently so an ACK lost after commit does not
// inflate the session's statistics.
const (
	discoveryReportMaxDevices   = 250
	discoveryReportDeviceBudget = 900 << 10
	discoveryReportBodyLimit    = 2 << 20
)

func buildDiscoveryReportPayloads(discoveryID, status string, devices []map[string]interface{}, sourceErrors []string) ([][]byte, error) {
	const maxReportedCandidates = 128 * discoveryReportMaxDevices
	originalCount := len(devices)
	diagnostics := make([]string, 0, 64)
	for _, errText := range sourceErrors {
		if len(diagnostics) >= 64 {
			break
		}
		diagnostics = append(diagnostics, boundedDiscoveryText(errText, 2048))
	}
	addDiagnostic := func(value string) {
		if len(diagnostics) < 64 {
			diagnostics = append(diagnostics, value)
		} else {
			diagnostics[63] = value
		}
	}

	// The Gateway limits the declared session total to 32,000. Retain a
	// bounded prefix rather than making every page fail validation on an
	// unusually large or faulty inventory source.
	if len(devices) > maxReportedCandidates {
		addDiagnostic(fmt.Sprintf("discovery contained %d observations; only the first %d could be reported", originalCount, maxReportedCandidates))
		devices = devices[:maxReportedCandidates]
		if status == "completed" {
			status = "partial"
		}
	}
	pages := make([][]json.RawMessage, 0, 2)
	page := make([]json.RawMessage, 0, discoveryReportMaxDevices)
	pageBytes := 0
	skipped := 0
	for _, device := range devices {
		item, err := json.Marshal(device)
		if err != nil || len(item) > discoveryReportDeviceBudget {
			skipped++
			continue
		}
		if len(page) >= discoveryReportMaxDevices || (len(page) > 0 && pageBytes+len(item)+1 > discoveryReportDeviceBudget) {
			pages = append(pages, page)
			page = make([]json.RawMessage, 0, discoveryReportMaxDevices)
			pageBytes = 0
		}
		page = append(page, json.RawMessage(item))
		pageBytes += len(item) + 1
	}
	if len(page) > 0 || len(pages) == 0 {
		pages = append(pages, page)
	}
	if skipped > 0 {
		addDiagnostic(fmt.Sprintf("%d discovery observations exceeded the per-device metadata budget or could not be encoded; local inventory was preserved", skipped))
		if status == "completed" {
			status = "partial"
		}
	}
	// More than 128 pages indicates a broken/unbounded inventory provider;
	// never exhaust Gateway memory or database writes to hide that condition.
	if len(pages) > 128 {
		addDiagnostic(fmt.Sprintf("discovery report exceeded 128 bounded pages; %d observations retained locally but not uploaded", len(devices)))
		pages = pages[:128]
		if status == "completed" {
			status = "partial"
		}
	}

	result := make([][]byte, 0, len(pages))
	for i, batch := range pages {
		batchStatus := "running"
		var batchErrors []string
		if i == len(pages)-1 {
			batchStatus = status
			batchErrors = diagnostics
		}
		if batchErrors == nil {
			batchErrors = []string{}
		}
		payload := struct {
			DiscoveryID     string            `json:"discoveryId"`
			Status          string            `json:"status"`
			Devices         []json.RawMessage `json:"devices"`
			Errors          []string          `json:"errors"`
			ChunkIndex      int               `json:"chunkIndex"`
			ChunkCount      int               `json:"chunkCount"`
			TotalCandidates int               `json:"totalCandidates"`
		}{discoveryID, batchStatus, batch, batchErrors, i, len(pages), len(devices)}
		body, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("encode discovery batch %d: %w", i, err)
		}
		if len(body) > discoveryReportBodyLimit {
			return nil, fmt.Errorf("discovery batch %d exceeded Gateway 2 MiB request limit", i)
		}
		result = append(result, body)
	}
	return result, nil
}

func (a *Agent) reportDiscoveryResult(ctx context.Context, discoveryID, status string, devices []map[string]interface{}, sourceErrors ...[]string) {
	diagnostics := []string{}
	for _, batch := range sourceErrors {
		for _, message := range batch {
			log.Printf("[discovery] session %s: %s", discoveryID, message)
			if len(diagnostics) < 64 {
				diagnostics = append(diagnostics, boundedDiscoveryText(message, 2048))
			}
		}
	}
	reqURL, err := config.GatewayEndpoint(a.cfg.Server.URL, "/api/agent/discovery")
	if err != nil {
		log.Printf("[discovery] invalid Gateway endpoint for %s: %v", discoveryID, err)
		return
	}
	batches, err := buildDiscoveryReportPayloads(discoveryID, status, devices, diagnostics)
	if err != nil {
		log.Printf("[discovery] cannot build bounded report for %s: %v", discoveryID, err)
		return
	}

	const maxAttempts = 5
	for batchIndex, body := range batches {
		backoff := 250 * time.Millisecond
		acknowledged := false
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
			if err != nil {
				log.Printf("[discovery] failed to build request for %s: %v", discoveryID, err)
				return
			}
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s:%s", a.cfg.Agent.ID, a.cfg.Agent.Secret))
			req.Header.Set("Content-Type", "application/json")
			resp, err := a.client.Do(req)
			if err == nil {
				code := resp.StatusCode
				responseBody, drainErr := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
				if drainErr != nil {
					log.Printf("[discovery] gateway response drain failed for %s: %v", discoveryID, drainErr)
				}
				_ = resp.Body.Close()
				if code >= 200 && code < 300 {
					acknowledged = true
					break
				}
				if code < 500 && code != http.StatusTooManyRequests {
					log.Printf("[discovery] gateway rejected report page %d/%d for %s: HTTP %d: %s", batchIndex+1, len(batches), discoveryID, code, firstLineOfBody(responseBody))
					return
				}
				log.Printf("[discovery] transient gateway response for %s: page %d/%d HTTP %d (attempt %d/%d)", discoveryID, batchIndex+1, len(batches), code, attempt, maxAttempts)
			} else {
				log.Printf("[discovery] failed to report page %d/%d for %s (attempt %d/%d): %v", batchIndex+1, len(batches), discoveryID, attempt, maxAttempts, err)
			}
			if attempt == maxAttempts {
				break
			}
			wait := backoff
			if next := backoff * 2; next <= 4*time.Second {
				backoff = next
			}
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		if !acknowledged {
			log.Printf("[discovery] %s report incomplete: page %d/%d not acknowledged", discoveryID, batchIndex+1, len(batches))
			return
		}
	}
	log.Printf("[discovery] session %s reported %d device observations in %d bounded batch(es): %s", discoveryID, len(devices), len(batches), status)
}
