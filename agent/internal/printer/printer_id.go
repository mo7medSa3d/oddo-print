package printer

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// ValidPrinterID is the native Agent's single definition for a printer
// identifier that can be transmitted unchanged through the Gateway's
// isExactPrinterId wire contract. It must never normalize or alias an ID:
// 120 UTF-8 bytes, valid Unicode, no control chars and no JS-trimmable
// whitespace (including U+FEFF BOM) at the boundaries.
//
// Local historical IDs may be longer. They remain local and cannot gain
// cloud sharing, geometry or verification authority from this check.
func ValidPrinterID(id string) bool {
	if id == "" || len(id) > 120 || !utf8.ValidString(id) || strings.ContainsFunc(id, unicode.IsControl) {
		return false
	}
	return strings.TrimFunc(id, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	}) == id
}

// ValidGatewayPrinterID is an alias for ValidPrinterID for backward compatibility.
func ValidGatewayPrinterID(id string) bool {
	return ValidPrinterID(id)
}
