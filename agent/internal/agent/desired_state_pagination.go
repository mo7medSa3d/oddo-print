package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	maxDesiredStatePageRows      = 64
	maxDesiredStatePageBytes     = 1 << 20
	maxDesiredStateSnapshotBytes = maxDesiredStateBytes / 2
)

func desiredStateCursorMatchesRows(rows []desiredPrinterWire, cursor string) bool {
	if cursor == "" {
		return true
	}
	if len(rows) == 0 || len(cursor) > 2732 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	return err == nil && string(decoded) == rows[len(rows)-1].ID && base64.RawURLEncoding.EncodeToString(decoded) == cursor
}

func validateDesiredStateRows(rows []desiredPrinterWire, seen map[string]struct{}) error {
	for _, row := range rows {
		if row.ID == "" || len(row.ID) > 2048 || row.DesiredRevision < 0 ||
			(row.Lifecycle != "active" && row.Lifecycle != "disabled" && row.Lifecycle != "retired") {
			return fmt.Errorf("invalid desired-state printer identity, revision or lifecycle")
		}
		if _, duplicate := seen[row.ID]; duplicate {
			return fmt.Errorf("duplicate printer in desired-state snapshot")
		}
		seen[row.ID] = struct{}{}
	}
	return nil
}

// Accumulate every page before authoritative absence reconciliation. A failed
// continuation never becomes a smaller full snapshot that deletes printers.
func (a *Agent) collectGatewayDesiredState(parent context.Context, rows []desiredPrinterWire, cursor string) ([]desiredPrinterWire, error) {
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	all := rows
	seenIDs := make(map[string]struct{})
	if err := validateDesiredStateRows(rows, seenIDs); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(rows)
	if err != nil || len(encoded) > maxDesiredStateSnapshotBytes {
		return nil, fmt.Errorf("desired-state snapshot exceeds the local metadata budget")
	}
	bytes := len(encoded)
	seen := make(map[string]struct{})
	for cursor != "" {
		if !desiredStateCursorMatchesRows(rows, cursor) {
			return nil, fmt.Errorf("invalid desired-state page cursor")
		}
		if _, duplicate := seen[cursor]; duplicate {
			return nil, fmt.Errorf("repeated desired-state page cursor")
		}
		seen[cursor] = struct{}{}
		endpoint := "/api/agent/desired-state?after=" + url.QueryEscape(cursor)
		resp, requestErr := a.doAuthorizedRequest(ctx, http.MethodGet, endpoint, nil)
		if requestErr != nil {
			return nil, fmt.Errorf("fetch desired-state continuation: %w", requestErr)
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxDesiredStatePageBytes+1))
		_ = resp.Body.Close()
		if readErr != nil || len(body) > maxDesiredStatePageBytes || resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("desired-state continuation unavailable (HTTP %d or invalid response size/read)", resp.StatusCode)
		}
		var page struct {
			Success    bool                  `json:"success"`
			AgentID    string                `json:"agentId"`
			Rows       *[]desiredPrinterWire `json:"desiredState"`
			NextCursor string                `json:"desiredStateNextCursor"`
		}
		if err := json.Unmarshal(body, &page); err != nil || !page.Success || page.AgentID != a.cfg.Agent.ID || page.Rows == nil || len(*page.Rows) > maxDesiredStatePageRows {
			return nil, fmt.Errorf("invalid desired-state continuation contract")
		}
		rows = *page.Rows
		if err := validateDesiredStateRows(rows, seenIDs); err != nil {
			return nil, err
		}
		encoded, err = json.Marshal(rows)
		if err != nil || bytes+len(encoded) > maxDesiredStateSnapshotBytes {
			return nil, fmt.Errorf("desired-state snapshot exceeds the local metadata budget")
		}
		bytes += len(encoded)
		all = append(all, rows...)
		cursor = page.NextCursor
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return all, nil
}
