package payload

import (
	"encoding/base64"
	"strings"
	"testing"
)

// Hot-path benchmarks for the print-job payload contract.
//
// payload.Parse runs once per delivered job on the agent's dispatch path
// (before any printing), so its cost is on the critical job-dispatch latency
// path. These benchmarks measure decode/validation cost across the realistic
// payload types and sizes the agent actually receives.
//
// Run with:
//
//	go test -bench=. -benchmem ./internal/payload/
//
// These are microbenchmarks: they measure CPU/alloc cost of parsing, NOT
// end-to-end print latency.

func b64(n int) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat("A", n)))
}

func rawPayload(size int) map[string]interface{} {
	return map[string]interface{}{
		"type":     "raw",
		"protocol": "raw",
		"encoding": "base64",
		"data":     b64(size),
	}
}

func escposPayload(size int) map[string]interface{} {
	return map[string]interface{}{
		"type":     "escpos",
		"protocol": "escpos",
		"encoding": "base64",
		"data":     b64(size),
		"peripherals": map[string]interface{}{
			"drawer": "pin2",
			"cutter": "full",
		},
	}
}

// pdfBase64 builds a base64 payload whose decoded bytes start with the
// required %PDF- signature followed by padding to reach the target size.
func pdfBase64(size int) string {
	sig := []byte("%PDF-1.7\n")
	if size < len(sig) {
		size = len(sig)
	}
	buf := make([]byte, size)
	copy(buf, sig)
	for i := len(sig); i < size; i++ {
		buf[i] = 'A'
	}
	return base64.StdEncoding.EncodeToString(buf)
}

func pdfPayload(size int) map[string]interface{} {
	return map[string]interface{}{
		"type":     "pdf",
		"encoding": "base64",
		"data":     pdfBase64(size),
	}
}

func benchParse(b *testing.B, raw map[string]interface{}) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Parse(raw); err != nil {
			b.Fatalf("unexpected parse error: %v", err)
		}
	}
}

// Small receipt-sized ESC/POS (a 40-column receipt is a few hundred bytes).
func BenchmarkParseESCPOS_Small(b *testing.B)  { benchParse(b, escposPayload(512)) }
func BenchmarkParseESCPOS_Medium(b *testing.B) { benchParse(b, escposPayload(8*1024)) }

func BenchmarkParseRaw_Small(b *testing.B)  { benchParse(b, rawPayload(512)) }
func BenchmarkParseRaw_Medium(b *testing.B) { benchParse(b, rawPayload(64*1024)) }

// A typical single-page A4 PDF report is on the order of tens to hundreds of KB.
func BenchmarkParsePDF_100KB(b *testing.B) { benchParse(b, pdfPayload(100*1024)) }
func BenchmarkParsePDF_1MB(b *testing.B)   { benchParse(b, pdfPayload(1024*1024)) }

// Rejection path: an unsupported type must fail fast and allocate little.
func BenchmarkParseReject_BadType(b *testing.B) {
	raw := map[string]interface{}{"type": "postscript", "data": b64(256)}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Parse(raw); err == nil {
			b.Fatal("expected rejection for unsupported type")
		}
	}
}
