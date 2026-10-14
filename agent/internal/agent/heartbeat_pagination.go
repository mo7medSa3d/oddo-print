package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"sync/atomic"
	"time"
)

// Versions are seeded from local time, but ordering is enforced by an atomic
// counter and the Gateway's durable high-water mark, never by clock agreement.
// A restarted process with a rolled-back clock catches up from a fenced 409.
type inventoryVersionClock struct {
	last atomic.Int64
}

var heartbeatInventoryClock inventoryVersionClock

func (c *inventoryVersionClock) next(now time.Time) string {
	for {
		previous := c.last.Load()
		next := now.UnixNano()
		if next <= previous {
			// Exhaustion fails closed as a duplicate rather than wrapping negative.
			if previous == int64(^uint64(0)>>1) {
				return strconv.FormatInt(previous, 10)
			}
			next = previous + 1
		}
		if c.last.CompareAndSwap(previous, next) {
			return strconv.FormatInt(next, 10)
		}
	}
}

func (c *inventoryVersionClock) observe(raw string) bool {
	version, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || version < 0 || strconv.FormatInt(version, 10) != raw {
		return false
	}
	for {
		previous := c.last.Load()
		if version <= previous || c.last.CompareAndSwap(previous, version) {
			return true
		}
	}
}

const (
	// The Gateway limit is deliberately a per-page protocol bound, not a
	// fleet-size limit. Printer metadata is kept below the Gateway's 256,000
	// byte aggregate page check so realistic capability/config payloads have
	// headroom for JSON framing.
	maxHeartbeatPrintersPerPage = 500
	maxHeartbeatPrinterBytes    = 220 * 1024
	maxHeartbeatAuxItemsPerPage = 500
	maxHeartbeatAuxBytes        = 64 * 1024
	maxHeartbeatEnvelopeBytes   = 512 * 1024
)

func splitHeartbeatPrinterPagesWithBudget(printers []map[string]interface{}, byteBudget int) [][]map[string]interface{} {
	if len(printers) == 0 {
		return [][]map[string]interface{}{{}}
	}

	pages := make([][]map[string]interface{}, 0, (len(printers)+maxHeartbeatPrintersPerPage-1)/maxHeartbeatPrintersPerPage)
	current := make([]map[string]interface{}, 0, maxHeartbeatPrintersPerPage)
	currentBytes := 2 // [] JSON framing
	for _, printer := range printers {
		encoded, err := json.Marshal(printer)
		if err != nil {
			// printerStatusPayload only builds JSON-compatible values. Keep this
			// helper fail-closed for any future extension that violates that
			// invariant: the offending entry gets its own page and the Gateway
			// validation remains authoritative.
			encoded = []byte("{}")
		}

		extra := len(encoded)
		if len(current) > 0 {
			extra++ // comma between array elements
		}
		if len(current) >= maxHeartbeatPrintersPerPage ||
			(len(current) > 0 && currentBytes+extra > byteBudget) {
			pages = append(pages, current)
			current = make([]map[string]interface{}, 0, maxHeartbeatPrintersPerPage)
			currentBytes = 2
			extra = len(encoded)
		}

		current = append(current, printer)
		currentBytes += extra
	}
	if len(current) > 0 {
		pages = append(pages, current)
	}
	return pages
}

func splitHeartbeatAuxPages[T any](items []T) [][]T {
	if len(items) == 0 {
		return [][]T{{}}
	}
	pages := make([][]T, 0, (len(items)+maxHeartbeatAuxItemsPerPage-1)/maxHeartbeatAuxItemsPerPage)
	current := make([]T, 0, maxHeartbeatAuxItemsPerPage)
	currentBytes := 2
	for _, item := range items {
		extra := heartbeatJSONBytes(item) + 1
		if len(current) > 0 && (len(current) >= maxHeartbeatAuxItemsPerPage || currentBytes+extra > maxHeartbeatAuxBytes) {
			pages = append(pages, current)
			current, currentBytes = make([]T, 0, maxHeartbeatAuxItemsPerPage), 2
		}
		current = append(current, item)
		currentBytes += extra
	}
	pages = append(pages, current)
	return pages
}

func heartbeatJSONBytes(value interface{}) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return maxHeartbeatEnvelopeBytes
	}
	return len(encoded)
}

func largestHeartbeatPageBytes[T any](pages [][]T) int {
	largest := 0
	for _, page := range pages {
		if size := heartbeatJSONBytes(page); size > largest {
			largest = size
		}
	}
	return largest
}

func gatewayOwnedIDsForPrinterPage(printers []map[string]interface{}, ownedIDs []string) []string {
	if len(printers) == 0 || len(ownedIDs) == 0 {
		// Encode as [] rather than null: the Gateway validates this fence as an array.
		return []string{}
	}
	owned := make(map[string]struct{}, len(ownedIDs))
	for _, id := range ownedIDs {
		if id != "" {
			owned[id] = struct{}{}
		}
	}

	result := make([]string, 0, len(printers))
	seen := make(map[string]struct{}, len(printers))
	for _, printer := range printers {
		id, ok := printer["id"].(string)
		if !ok || id == "" {
			continue
		}
		if _, ok := owned[id]; !ok {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func newInventorySnapshotID() string {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err == nil {
		return hex.EncodeToString(nonce[:])
	}
	// crypto/rand failure must not stop presence heartbeats. The Agent sends
	// snapshots serially, so a process-local nanosecond fallback is sufficient
	// to preserve the page fence until the next heartbeat cycle.
	return "fallback-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func buildHeartbeatPayloadPages(
	printers []map[string]interface{},
	desiredAcks []map[string]interface{},
	gatewayOwnedIDs []string,
	privatePrinterIDs []string,
	keepAlive []map[string]string,
	inventoryComplete bool,
) []map[string]interface{} {
	ackPages := splitHeartbeatAuxPages(desiredAcks)
	privatePages := splitHeartbeatAuxPages(privatePrinterIDs)
	// Gateway-owned IDs duplicate at most the printer page's encoded bytes.
	// Reserve actual auxiliary/keepalive sizes plus framing before dividing
	// the remaining512KiB envelope between metadata and that ownership fence.
	printerBudget := (maxHeartbeatEnvelopeBytes - 4096 - heartbeatJSONBytes(keepAlive) - largestHeartbeatPageBytes(ackPages) - largestHeartbeatPageBytes(privatePages)) / 2
	if printerBudget > maxHeartbeatPrinterBytes {
		printerBudget = maxHeartbeatPrinterBytes
	}
	if printerBudget < 1 {
		printerBudget = 1
	}
	printerPages := splitHeartbeatPrinterPagesWithBudget(printers, printerBudget)
	totalPages := len(printerPages)
	if len(ackPages) > totalPages {
		totalPages = len(ackPages)
	}
	if len(privatePages) > totalPages {
		totalPages = len(privatePages)
	}
	if totalPages == 0 {
		totalPages = 1
	}

	snapshotID := newInventorySnapshotID()
	snapshotVersion := heartbeatInventoryClock.next(time.Now())
	pages := make([]map[string]interface{}, 0, totalPages)
	for i := 0; i < totalPages; i++ {
		var pagePrinters []map[string]interface{}
		if i < len(printerPages) {
			pagePrinters = printerPages[i]
		} else {
			pagePrinters = []map[string]interface{}{}
		}

		var pageAcks []map[string]interface{}
		if i < len(ackPages) {
			pageAcks = ackPages[i]
		} else {
			pageAcks = []map[string]interface{}{}
		}

		page := map[string]interface{}{
			"status":                   "online",
			"printers":                 pagePrinters,
			"desiredStateAcks":         pageAcks,
			"gatewayOwnedPrinterIds":   gatewayOwnedIDsForPrinterPage(pagePrinters, gatewayOwnedIDs),
			"heartbeatPage":            i + 1,
			"heartbeatPageCount":       totalPages,
			"inventorySnapshotId":      snapshotID,
			"inventorySnapshotVersion": snapshotVersion,
			"inventoryComplete":        inventoryComplete,
		}
		if len(keepAlive) > 0 {
			// In-flight ownership is independent of current sharing policy.
			page["keepAliveJobIds"] = keepAlive
		}
		if i < len(privatePages) && len(privatePages[i]) > 0 {
			page["privatePrinterIds"] = privatePages[i]
		}
		// One individually valid capability/config record can exceed the
		// reserved metadata slice after Go HTML escaping. Keep that record;
		// move auxiliary data to a later page rather than lose any field/ID.
		if heartbeatJSONBytes(page) > maxHeartbeatEnvelopeBytes-128 && i < len(privatePages) && len(privatePages[i]) > 0 {
			privatePages = append(privatePages, privatePages[i])
			privatePages[i] = []string{}
			delete(page, "privatePrinterIds")
		}
		if heartbeatJSONBytes(page) > maxHeartbeatEnvelopeBytes-128 && len(pageAcks) > 0 {
			ackPages = append(ackPages, pageAcks)
			ackPages[i] = []map[string]interface{}{}
			page["desiredStateAcks"] = []map[string]interface{}{}
		}
		if len(privatePages) > totalPages {
			totalPages = len(privatePages)
		}
		if len(ackPages) > totalPages {
			totalPages = len(ackPages)
		}
		pages = append(pages, page)
	}
	for _, page := range pages {
		page["heartbeatPageCount"] = len(pages)
	}
	return pages
}
