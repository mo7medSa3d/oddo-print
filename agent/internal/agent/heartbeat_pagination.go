package agent

// Odoo accepts bounded printer inventory batches. Batching is only a request
// size safeguard; there is no remote desired-state or fleet reconciliation.
func buildDirectHeartbeatPayloadPages(printers []map[string]interface{}, keepAliveJobIDs []map[string]string) []map[string]interface{} {
	const pageSize = 100
	if len(printers) == 0 {
		return []map[string]interface{}{{
			"printers":        []map[string]interface{}{},
			"keepAliveJobIds": keepAliveJobIDs,
		}}
	}
	pages := make([]map[string]interface{}, 0, (len(printers)+pageSize-1)/pageSize)
	for start := 0; start < len(printers); start += pageSize {
		end := start + pageSize
		if end > len(printers) {
			end = len(printers)
		}
		page := make([]map[string]interface{}, end-start)
		copy(page, printers[start:end])
		pages = append(pages, map[string]interface{}{
			"printers":        page,
			"keepAliveJobIds": keepAliveJobIDs,
		})
	}
	return pages
}

// printerPayloadForPage accepts the page envelope used by the Agent HTTP
// heartbeat sender and returns its printer batch.
func printerPayloadForPage(payload interface{}) []map[string]interface{} {
	switch value := payload.(type) {
	case []map[string]interface{}:
		return value
	case map[string]interface{}:
		if rows, ok := value["printers"].([]map[string]interface{}); ok {
			return rows
		}
	}
	return nil
}
