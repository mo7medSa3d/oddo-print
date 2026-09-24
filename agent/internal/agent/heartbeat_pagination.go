package agent

import "encoding/json"

const (
	// The Gateway limit is deliberately a per-page protocol bound, not a
	// fleet-size limit. Printer metadata is kept below the Gateway's 256,000
	// byte aggregate page check so realistic capability/config payloads have
	// headroom for JSON framing.
	maxHeartbeatPrintersPerPage = 500
	maxHeartbeatPrinterBytes    = 220 * 1024
	maxHeartbeatAuxItemsPerPage = 500
)

func splitHeartbeatPrinterPages(printers []map[string]interface{}) [][]map[string]interface{} {
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
			(len(current) > 0 && currentBytes+extra > maxHeartbeatPrinterBytes) {
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
	for start := 0; start < len(items); start += maxHeartbeatAuxItemsPerPage {
		end := start + maxHeartbeatAuxItemsPerPage
		if end > len(items) {
			end = len(items)
		}
		pages = append(pages, items[start:end])
	}
	return pages
}

func gatewayOwnedIDsForPrinterPage(printers []map[string]interface{}, ownedIDs []string) []string {
	if len(printers) == 0 || len(ownedIDs) == 0 {
		return nil
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

func buildHeartbeatPayloadPages(
	printers []map[string]interface{},
	desiredAcks []map[string]interface{},
	gatewayOwnedIDs []string,
	keepAlive []map[string]string,
) []map[string]interface{} {
	printerPages := splitHeartbeatPrinterPages(printers)
	ackPages := splitHeartbeatAuxPages(desiredAcks)
	totalPages := len(printerPages)
	if len(ackPages) > totalPages {
		totalPages = len(ackPages)
	}
	if totalPages == 0 {
		totalPages = 1
	}

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
			"status":                 "online",
			"printers":               pagePrinters,
			"desiredStateAcks":       pageAcks,
			"gatewayOwnedPrinterIds": gatewayOwnedIDsForPrinterPage(pagePrinters, gatewayOwnedIDs),
			"heartbeatPage":          i + 1,
			"heartbeatPageCount":     totalPages,
		}
		if len(keepAlive) > 0 {
			page["keepAliveJobIds"] = keepAlive
		}
		pages = append(pages, page)
	}
	return pages
}
