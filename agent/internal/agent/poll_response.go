package agent

import (
	"encoding/json"
	"fmt"
	"io"
)

// decodeBoundedGatewayList validates the ENTIRE authenticated Gateway response
// before permitting any local dispatch. Decode alone accepts the first JSON
// value and leaves trailing data unread, and decoding an entire untrusted
// array before checking its item count can allocate far beyond the item budget.
// The limited reader includes one sentinel byte beyond the byte budget.
// Decode elements incrementally and reject an excess item before decoding it.
// All accepted elements remain buffered until both the array and trailing body
// have been fully validated; no caller can dispatch a partial batch.
func decodeBoundedGatewayList(body io.Reader, maxBytes int64, maxItems int) ([]map[string]interface{}, error) {
	if maxBytes < 1 || maxBytes == int64(^uint64(0)>>1) || maxItems < 1 {
		return nil, fmt.Errorf("invalid Gateway list response budget")
	}
	limited := &io.LimitedReader{R: body, N: maxBytes + 1}
	decoder := json.NewDecoder(limited)
	token, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("invalid Gateway list JSON: %w", err)
	}
	if token != json.Delim('[') {
		return nil, fmt.Errorf("Gateway list response must be a JSON array")
	}

	items := make([]map[string]interface{}, 0, maxItems)
	for decoder.More() {
		if len(items) == maxItems {
			return nil, fmt.Errorf("Gateway list response exceeds %d entries", maxItems)
		}
		var item map[string]interface{}
		if err := decoder.Decode(&item); err != nil {
			return nil, fmt.Errorf("invalid Gateway list entry: %w", err)
		}
		if item == nil {
			return nil, fmt.Errorf("Gateway list response contains a null entry")
		}
		items = append(items, item)
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim(']') {
		return nil, fmt.Errorf("invalid Gateway list closing bracket: %v", err)
	}

	// The decoder may read ahead into its internal buffer. Scan both the
	// buffered bytes and remaining network body, so a second JSON value,
	// garbage, truncated transfer, or oversized whitespace suffix is rejected.
	remaining := io.MultiReader(decoder.Buffered(), limited)
	var scratch [32 * 1024]byte
	for {
		n, err := remaining.Read(scratch[:])
		for _, b := range scratch[:n] {
			if b != ' ' && b != '\n' && b != '\t' && b != '\r' {
				return nil, fmt.Errorf("Gateway list response has trailing content")
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading Gateway list response: %w", err)
		}
	}
	if limited.N == 0 {
		return nil, fmt.Errorf("Gateway list response exceeds %d-byte budget", maxBytes)
	}
	return items, nil
}

// Job polling and Agent discovery share the same strict list framing.
func decodeBoundedPollJobs(body io.Reader, maxBytes int64, maxJobs int) ([]map[string]interface{}, error) {
	return decodeBoundedGatewayList(body, maxBytes, maxJobs)
}
