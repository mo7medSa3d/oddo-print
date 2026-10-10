package printer

import (
	"strings"
	"testing"
)

func TestMalformedIPPPrinterURLNeverLeaksCredentials(t *testing.T) {
	for _, raw := range []string{
		"ipp://operator:superSecret123@[invalid",
		"ipps://operator:superSecret123@%zz/ipp/print",
	} {
		_, err := normalizeIPPURL(raw)
		if err == nil {
			t.Fatalf("malformed URL %q accepted", raw)
		}
		if strings.Contains(err.Error(), "superSecret123") || strings.Contains(err.Error(), "operator") {
			t.Fatalf("IPP URL error includes supplied credentials: %q", err.Error())
		}
	}
}
