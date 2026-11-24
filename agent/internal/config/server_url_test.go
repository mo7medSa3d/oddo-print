package config

import (
	"net/url"
	"strings"
	"testing"
)

func TestOdooEndpointsPreserveOriginAndCanonicalAPIPaths(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		origin string
	}{
		{" https://odoo.example.com/ ", "https://odoo.example.com"},
		{"HTTPS://odoo.example.com:8443", "https://odoo.example.com:8443"},
		{"http://192.0.2.10:3000/", "http://192.0.2.10:3000"},
		{"https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"},
		{"https://[::1]/", "https://[::1]"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			origin, err := OdooOrigin(tc.raw)
			if err != nil || origin != tc.origin {
				t.Fatalf("origin = %q, %v; want %q", origin, err, tc.origin)
			}
			endpoint, err := OdooEndpoint(tc.raw, "/api/agent/desired-state?after=a%2Bb")
			if err != nil || endpoint != tc.origin+"/api/agent/desired-state?after=a%2Bb" {
				t.Fatalf("HTTP endpoint = %q, %v", endpoint, err)
			}
			parsed, err := url.Parse(endpoint)
			if err != nil || parsed.Query().Get("after") != "a+b" {
				t.Fatalf("cursor query changed: %q, %v", endpoint, err)
			}
		})
	}
}

func TestOdooURLContractRejectsUnsupportedOrSecretBearingOrigins(t *testing.T) {
	for _, raw := range []string{
		"https://odoo.example.com/base", "https://odoo.example.com/api/", "https://odoo.example.com//",
		"https://odoo.example.com/%2f", "https://@odoo.example.com/", "https://:@odoo.example.com/", "https://user:test-secret@odoo.example.com/",
		"https://user:test-secret@odoo.example.com:invalid/", "https://odoo.example.com/?token=test-secret",
		"https://odoo.example.com/?", "https://odoo.example.com/#", "https://odoo.example.com/#fragment",
		"https://odoo.example.com:0/", "https://odoo.example.com:65536/", "https://odoo.example.com:/",
		"https://2001:db8::1/", "https://2001:db8::1:8443/",
		"https://.example.com/", "https://gateway..example.com/", "https://-odoo.example.com/",
		"https://gateway-.example.com/", "https://[fe80::1%25eth0]/",
		"ftp://odoo.example.com/", "https:///missing-host",
	} {
		t.Run(raw, func(t *testing.T) {
			if err := ValidateServerURL(raw); err == nil || strings.Contains(err.Error(), "test-secret") {
				t.Fatalf("origin accepted or error exposed a secret: %v", err)
			}
			if _, err := OdooEndpoint(raw, "/api/agent/jobs"); err == nil {
				t.Fatal("HTTP endpoint accepted an invalid origin")
			}
		})
	}
}

func TestOdooEndpointCannotEscapeConfiguredOriginOrAPIPath(t *testing.T) {
	for _, apiPath := range []string{
		"https://other.example.com/api/agent/jobs", "//other.example.com/api/agent/jobs", "api/agent/jobs",
		"/api/../auth", "/api/%2e%2e/auth", "/api//agent/jobs", "/api/agent/jobs#fragment",
		"/api/agent/jobs#", "/api/agent\\jobs", "/health",
	} {
		if _, err := OdooEndpoint("https://odoo.example.com/", apiPath); err == nil {
			t.Fatalf("unsafe endpoint accepted: %q", apiPath)
		}
	}
}
