package printer

import (
	"net"
	"testing"
)

func TestIPPBareIPNormalizationKeepsIPv6Authority(t *testing.T) {
	for _, tc := range []struct{ input, scheme, host, port string }{
		{"fd12:3456::10", "http", "fd12:3456::10", "631"},
		{"[fd12:3456::10]", "http", "fd12:3456::10", "631"},
		{"[fd12:3456::10]:631", "http", "fd12:3456::10", "631"},
		{"192.168.1.50", "http", "192.168.1.50", "631"},
		{"192.168.1.50:631", "http", "192.168.1.50", "631"},
		{"ipps://[fd12:3456::10]/ipp/print", "https", "fd12:3456::10", "631"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			u, err := normalizeIPPURL(tc.input)
			if err != nil {
				t.Fatal(err)
			}
			host, port, err := net.SplitHostPort(u.Host)
			if err != nil || host != tc.host || port != tc.port || u.Scheme != tc.scheme || u.Path != "/ipp/print" {
				t.Fatalf("invalid printer authority after normalization: %s (host=%q port=%q err=%v)", u, host, port, err)
			}
		})
	}
}
