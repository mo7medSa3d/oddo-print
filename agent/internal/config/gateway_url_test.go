package config

import (
	"net/url"
	"strings"
	"testing"
)

func TestGatewayEndpointsPreserveOriginAndCanonicalAPIPaths(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		origin string
		ws     string
	}{
		{" https://gateway.example.com/ ", "https://gateway.example.com", "wss://gateway.example.com/api/agent/ws"},
		{"HTTPS://gateway.example.com:8443", "https://gateway.example.com:8443", "wss://gateway.example.com:8443/api/agent/ws"},
		{"http://192.0.2.10:3000/", "http://192.0.2.10:3000", "ws://192.0.2.10:3000/api/agent/ws"},
		{"https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443", "wss://[2001:db8::1]:8443/api/agent/ws"},
		{"https://[::1]/", "https://[::1]", "wss://[::1]/api/agent/ws"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			origin, err := GatewayOrigin(tc.raw)
			if err != nil || origin != tc.origin {
				t.Fatalf("origin = %q, %v; want %q", origin, err, tc.origin)
			}
			endpoint, err := GatewayEndpoint(tc.raw, "/api/agent/desired-state?after=a%2Bb")
			if err != nil || endpoint != tc.origin+"/api/agent/desired-state?after=a%2Bb" {
				t.Fatalf("HTTP endpoint = %q, %v", endpoint, err)
			}
			parsed, err := url.Parse(endpoint)
			if err != nil || parsed.Query().Get("after") != "a+b" {
				t.Fatalf("cursor query changed: %q, %v", endpoint, err)
			}
			ws, err := GatewayWebSocketURL(tc.raw)
			if err != nil || ws != tc.ws {
				t.Fatalf("WS endpoint = %q, %v; want %q", ws, err, tc.ws)
			}
		})
	}
}

func TestGatewayURLContractRejectsUnsupportedOrSecretBearingOrigins(t *testing.T) {
	for _, raw := range []string{
		"https://gateway.example.com/base", "https://gateway.example.com/api/", "https://gateway.example.com//",
		"https://gateway.example.com/%2f", "https://user:test-secret@gateway.example.com/",
		"https://user:test-secret@gateway.example.com:invalid/", "https://gateway.example.com/?token=test-secret",
		"https://gateway.example.com/?", "https://gateway.example.com/#", "https://gateway.example.com/#fragment",
		"https://gateway.example.com:0/", "https://gateway.example.com:65536/", "https://gateway.example.com:/",
		"https://2001:db8::1/", "https://2001:db8::1:8443/",
		"ftp://gateway.example.com/", "https:///missing-host",
	} {
		t.Run(raw, func(t *testing.T) {
			if err := ValidateServerURL(raw); err == nil || strings.Contains(err.Error(), "test-secret") {
				t.Fatalf("origin accepted or error exposed a secret: %v", err)
			}
			if _, err := GatewayEndpoint(raw, "/api/agent/jobs"); err == nil {
				t.Fatal("HTTP endpoint accepted an invalid origin")
			}
			if _, err := GatewayWebSocketURL(raw); err == nil {
				t.Fatal("WS endpoint accepted an invalid origin")
			}
		})
	}
}

func TestGatewayEndpointCannotEscapeConfiguredOriginOrAPIPath(t *testing.T) {
	for _, apiPath := range []string{
		"https://other.example.com/api/agent/jobs", "//other.example.com/api/agent/jobs", "api/agent/jobs",
		"/api/../auth", "/api/%2e%2e/auth", "/api//agent/jobs", "/api/agent/jobs#fragment",
		"/api/agent/jobs#", "/api/agent\\jobs", "/health",
	} {
		if _, err := GatewayEndpoint("https://gateway.example.com/", apiPath); err == nil {
			t.Fatalf("unsafe endpoint accepted: %q", apiPath)
		}
	}
}
