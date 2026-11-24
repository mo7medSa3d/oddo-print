package dependencysecurity

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
)

func TestClientIPRequiresTrustedImmediatePeer(t *testing.T) {
	for _, tc := range []struct {
		name, peer, forwarded, expected string
	}{
		{"untrusted_direct_peer", "198.51.100.10:1234", "203.0.113.44", "198.51.100.10"},
		{"untrusted_ipv4_mapped_peer", "[::ffff:198.51.100.10]:1234", "203.0.113.44", "198.51.100.10"},
		{"invalid_peer_fails_closed", "invalid", "203.0.113.44", ""},
		{"trusted_proxy", "10.1.2.3:1234", "203.0.113.44", "203.0.113.44"},
		{"trusted_chain", "10.1.2.3:1234", "203.0.113.44, 10.2.3.4", "203.0.113.44"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
			req.RemoteAddr = tc.peer
			req.Header.Set("X-Forwarded-For", tc.forwarded)
			var actual string
			handler := middleware.ClientIPFromXFF("10.0.0.0/8")(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				actual = middleware.GetClientIP(r.Context())
			}))
			handler.ServeHTTP(httptest.NewRecorder(), req)
			if actual != tc.expected {
				t.Fatalf("peer trust changed: got %q, want %q", actual, tc.expected)
			}
		})
	}
}
