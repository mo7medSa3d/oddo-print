package agent

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Exercise the actual discovery lookup method: a syntactically valid prefix
// cannot authorize a printer-discovery scan when the Gateway list envelope is
// malformed, duplicated, or longer than the documented API page bound.
func TestDiscoveryLookupRequiresCompleteBoundedGatewayResponse(t *testing.T) {
	for name, body := range map[string]string{
		"extra_json_value":  `[{"id":"session-1"}]true`,
		"trailing_garbage":  `[{"id":"session-1"}]garbage`,
		"too_many_sessions": `[{}, {}, {}, {}, {}, {"id":"session-1"}]`,
		"missing_array":     `{"id":"session-1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			call := func(context.Context) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
			}
			if got := loadDiscoverySessionByID(context.Background(), call, "session-1"); got != nil {
				t.Fatalf("invalid Gateway discovery list authorized a scan: %#v", got)
			}
		})
	}
	call := func(context.Context) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`[{"id":"session-1"}]`))}, nil
	}
	if got := loadDiscoverySessionByID(context.Background(), call, "session-1"); got == nil {
		t.Fatal("valid discovery session response was rejected")
	}
}
