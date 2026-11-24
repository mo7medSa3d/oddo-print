package printer

import "testing"

func TestPDFRenderBoundsKeepBudgetForExtremeAspectRatios(t *testing.T) {
	for _, size := range [][2]int{{1, 2_000_000_000}, {2_000_000_000, 1}, {2, 2_000_000_000}, {4960, 7016}, {640, 828}, {1, 1}} {
		w, h, err := renderBounds(size[0], size[1])
		if err != nil || w <= 0 || h <= 0 || w > size[0] || h > size[1] || w > maxPDFRenderPixels/h {
			t.Fatalf("source=%v yielded %dx%d outside pixel budget %d: %v", size, w, h, maxPDFRenderPixels, err)
		}
	}
}

func TestPDFRenderBoundsRejectInvalidSizes(t *testing.T) {
	for _, size := range [][2]int{{0, 1}, {1, 0}, {-1, 2}, {2, -1}} {
		if _, _, err := renderBounds(size[0], size[1]); err == nil {
			t.Fatalf("invalid size admitted: %v", size)
		}
	}
}

func TestRenderBoundsPreserveDenserDriverAxis(t *testing.T) {
	for _, tc := range [][6]int{{576, 3976, 203, 203, 576, 3976}, {850, 3470, 300, 300, 850, 3470}, {1700, 3470, 600, 300, 1700, 6940}, {1700, 6940, 600, 600, 1700, 6940}} {
		w, h, err := renderBoundsForDPI(tc[0], tc[1], tc[2], tc[3])
		if err != nil || w != tc[4] || h != tc[5] {
			t.Fatalf("driver %v produced %dx%d: %v", tc, w, h, err)
		}
	}
	if _, _, err := renderBoundsForDPI(576, 3000, 0, 203); err == nil {
		t.Fatal("unknown DPI accepted")
	}
}
