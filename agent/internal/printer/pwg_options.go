package printer

import (
	"fmt"
	"strconv"
	"strings"
)

// PWG Raster options advertised by Get-Printer-Attributes. A printer may
// support only a subset of resolutions and color spaces. Always use its own
// values when provided; do not claim sRGB or 300dpi without evidence if the
// printer explicitly supplies a conflicting set.
func pwgOptionsFromIPPAttributes(attrs map[string]string) (int, pwgRasterColor, error) {
	dpi := 300 // PWG Raster common default if printer omits capability
	if raw := strings.TrimSpace(attrs["pwg-raster-document-resolution-supported"]); raw != "" {
		resolutions := strings.Split(raw, ",")
		best := 0
		for _, item := range resolutions {
			item = strings.TrimSpace(strings.ToLower(item))
			// RFC 8011 resolution values can be DPI or dots per cm.
			// Hardware reporting only dpcm remains fully IPP-compliant.
			unit := "dpi"
			if strings.HasSuffix(item, "dpcm") {
				unit = "dpcm"
			} else if !strings.HasSuffix(item, unit) {
				continue
			}
			parts := strings.Split(strings.TrimSuffix(item, unit), "x")
			if len(parts) != 2 {
				continue
			}
			x, errX := strconv.Atoi(parts[0])
			y, errY := strconv.Atoi(parts[1])
			if errX != nil || errY != nil || x != y || x <= 0 || x > 1200 {
				continue
			}
			if unit == "dpcm" {
				// 1in = 2.54cm; round to integer DPI as required by
				// the PWG Raster page header, avoiding float precision.
				x = (x*254 + 50) / 100
			}
			if x > 1200 {
				continue
			}
			// Prefer 300dpi for a good thermal/laser result and bounded
			// memory use; otherwise use the closest supported value.
			if best == 0 || (x <= 300 && (best > 300 || x > best)) || (best > 300 && x < best) {
				best = x
			}
		}
		if best == 0 {
			return 0, pwgGray8, fmt.Errorf("printer supplied no usable square DPI resolution in %q", raw)
		}
		dpi = best
	}
	color := pwgGray8
	if raw := strings.TrimSpace(attrs["pwg-raster-document-type-supported"]); raw != "" {
		var gray, rgb bool
		for _, token := range strings.Split(raw, ",") {
			switch strings.ToLower(strings.TrimSpace(token)) {
			case "sgray_8":
				gray = true
			case "srgb_8":
				rgb = true
			}
		}
		if !gray && !rgb {
			return 0, pwgGray8, fmt.Errorf("printer supports neither sgray_8 nor srgb_8 PWG Raster: %q", raw)
		}
		if !gray && rgb {
			color = pwgRGB8
		}
	}
	return dpi, color, nil
}
