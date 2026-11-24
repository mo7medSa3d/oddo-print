package printer

import (
	"context"
	"log"
	"strings"
)

func rasterGeometryReady(g *Geometry) bool {
	return g.Validate() == nil && g.RasterCommand == "gs_v_0"
}

// prepareESCPOSImageForDispatch prepares an image job for a byte
// transport (raw TCP / USB) using the geometry the dispatch layer
// resolved for this job when the context carries one. Dispatch
// resolution already applied the advisory fallback policy (cached,
// measured, last-known, configured default), including logging a
// fingerprint drift as a warning and printing anyway — so the backend
// must not re-impose the fingerprint refusal the policy abolished;
// only the physical guards (ESC/POS protocol, gs_v_0 raster command,
// printable width) still apply. Without a dispatch geometry (direct
// callers) the strict measure-and-match preparation below is kept.
func prepareESCPOSImageForDispatch(ctx context.Context, protocol string, configured *Geometry, doc Document) ([]byte, error) {
	if resolved := DispatchGeometry(ctx); resolved != nil {
		if err := resolved.CheckImageFingerprint(doc.GeometryFingerprint); err != nil {
			log.Printf("[printer] advisory: image rendered for a different geometry fingerprint on a byte transport; printing with the dispatch-resolved geometry (%v)", err)
		}
		return prepareESCPOSImageMode(protocol, resolved, doc, false)
	}
	return prepareESCPOSImageMode(protocol, configured, doc, true)
}

// All byte transports share this preparation gate. It runs before a socket,
// USB handle or physical submission is opened, and never emits a partial image.
func prepareESCPOSImage(protocol string, g *Geometry, doc Document) ([]byte, error) {
	return prepareESCPOSImageMode(protocol, g, doc, true)
}

func prepareESCPOSImageMode(protocol string, g *Geometry, doc Document, enforceFingerprint bool) ([]byte, error) {
	if !strings.EqualFold(strings.TrimSpace(protocol), "escpos") {
		return nil, CapabilityMismatchf("image raster output requires explicit ESC/POS transport")
	}
	if enforceFingerprint {
		if err := g.CheckImageFingerprint(doc.GeometryFingerprint); err != nil {
			return nil, err
		}
	}
	if g.RasterCommand != "gs_v_0" {
		return nil, CapabilityMismatchf("printer profile must explicitly declare raster_command gs_v_0")
	}
	cfg, err := decodeJPEGConfig(doc.Data)
	if err != nil {
		return nil, err
	}
	if cfg.Width > g.PrintableWidthDots {
		return nil, CapabilityMismatchf("image width %d exceeds measured printable width %d; render again with current geometry", cfg.Width, g.PrintableWidthDots)
	}
	raster, err := JPEGToESCPOSWithMaxWidth(doc.Data, DefaultRasterSliceHeight, g.PrintableWidthDots)
	if err != nil {
		return nil, err
	}
	if doc.Peripherals != nil {
		raster = WrapPeripheralCommands(raster, protocol, *doc.Peripherals)
	}
	return raster, nil
}
