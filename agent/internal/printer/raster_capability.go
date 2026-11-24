package printer

import (
	"fmt"
	"strconv"
	"strings"
)

// Nominal paper millimetres do not establish an execution-safe dot budget.
func RasterMaxWidthFromPaperWidthMM(mm int) int { return 0 }

func RasterMaxWidthForConfiguredPaper(mm int, caps map[string]interface{}) int {
	return RasterMaxWidthFromCapabilities(caps)
}

// RasterMaxWidthFromCapabilities accepts a validated snapshot or explicit legacy
// dot measurement. Legacy millimetre values and absent geometry remain unknown.
// The upper bound is a software allocation limit, not a printer-head claim.
func RasterMaxWidthFromCapabilities(caps map[string]interface{}) int {
	if g := GeometryFromCapabilities(caps); g != nil {
		return g.PrintableWidthDots
	}
	if v, ok := capabilityInt(caps["max_paper_width"]); ok && v > 128 && v <= MaxJPEGDimension {
		return v
	}
	return 0
}

func capabilityInt(v interface{}) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int8:
		return int(x), true
	case int16:
		return int(x), true
	case int32:
		return int(x), true
	case int64:
		return int(x), true
	case uint:
		return int(x), true
	case uint8:
		return int(x), true
	case uint16:
		return int(x), true
	case uint32:
		return int(x), true
	case uint64:
		if uint64(int(x)) != x {
			return 0, false
		}
		return int(x), true
	case float64:
		if x != float64(int(x)) {
			return 0, false
		}
		return int(x), true
	case float32:
		y := float64(x)
		if y != float64(int(y)) {
			return 0, false
		}
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, false
		}
		return n, true
	case fmt.Stringer:
		n, err := strconv.Atoi(strings.TrimSpace(x.String()))
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
