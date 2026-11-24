package agent

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// observationCache holds the most recent BACKGROUND observations per
// printer: the geometry measured by the heartbeat probe loop and the
// latest operational-verification outcome. Measurement lives here, on the
// probe cycle — never synchronously in the print path. Dispatch reads the
// cache so a job prints with the last known size when a live measurement
// would be slow or failing, and treats verification purely as advisory
// evidence (see verifyPrinterForDispatch).
type observationCache struct {
	mu              sync.RWMutex
	geometry        map[string]*printer.Geometry
	verification    map[string]*printer.OperationalVerification
	verificationErr map[string]string
}

func newObservationCache() *observationCache {
	return &observationCache{
		geometry:        make(map[string]*printer.Geometry),
		verification:    make(map[string]*printer.OperationalVerification),
		verificationErr: make(map[string]string),
	}
}

// record stores one completed probe cycle's observations. Nil geometry /
// verification leave the previous values untouched: a single failed cycle
// must not erase the last known size or the last successful proof.
func (c *observationCache) record(id string, geometry *printer.Geometry, verification *printer.OperationalVerification, verificationErr string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if geometry != nil {
		c.geometry[id] = geometry
	}
	if verification != nil {
		c.verification[id] = verification
		delete(c.verificationErr, id)
	} else if verificationErr != "" {
		c.verificationErr[id] = verificationErr
	}
}

func (c *observationCache) geometryFor(id string) *printer.Geometry {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.geometry[id]
}

// verificationAdvisory returns "" when a fresh background verification
// proof exists for the printer, and otherwise a short log-ready reason.
// Freshness mirrors OperationalVerification.Validate's window (300 s).
// The result is advisory only: it is logged at dispatch, never enforced.
func (c *observationCache) verificationAdvisory(id string, now time.Time) string {
	if c == nil {
		return "no background verification has completed yet"
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	proof := c.verification[id]
	if proof == nil {
		if errText := c.verificationErr[id]; errText != "" {
			return "last background verification failed: " + errText
		}
		return "no background verification has completed yet"
	}
	verifiedAt, err := time.Parse(time.RFC3339Nano, proof.VerifiedAt)
	if err != nil {
		return "last background verification proof is unreadable"
	}
	if now.Sub(verifiedAt) > 300*time.Second {
		return "last successful background verification is stale (verified at " + proof.VerifiedAt + ")"
	}
	return ""
}

// defaultRasterDPI is the fallback resolution used when a spooler printer
// has never produced a measured geometry and its configured profile omits
// DPI/paper metrics: 203 DPI is the near-universal thermal default, and
// the Windows print path scales the rendered page to the driver's real
// printable area anyway, so the job prints at a sane default size instead
// of being refused for missing measurements.
const defaultRasterDPI = 203

// withDefaultImageMetrics fills only the metrics a spooler image render
// strictly needs (both DPI axes and a paper width) when the configured
// default geometry lacks them. Measured geometries pass through untouched.
func withDefaultImageMetrics(pc config.PrinterConfig, g *printer.Geometry) *printer.Geometry {
	if g == nil || pc.NormalizedType() != "spooler" {
		return g
	}
	if g.DPIX != nil && g.DPIY != nil && g.PaperWidthMM != nil {
		return g
	}
	out := *g
	if out.DPIX == nil || out.DPIY == nil {
		dpi := defaultRasterDPI
		if out.DPIX == nil {
			out.DPIX = &dpi
		}
		if out.DPIY == nil {
			out.DPIY = &dpi
		}
	}
	if out.PaperWidthMM == nil && out.DPIX != nil && *out.DPIX > 0 {
		widthMM := float64(out.PrintableWidthDots) / float64(*out.DPIX) * 25.4
		out.PaperWidthMM = &widthMM
	}
	log.Printf("print dispatch: configured geometry for printer %s lacks measured DPI/paper metrics; printing with default %d DPI metrics", pc.ID, defaultRasterDPI)
	return &out
}

// dispatchGeometryTimeout bounds the one live measurement dispatch may
// attempt when no cached geometry matches. It matches the heartbeat probe
// loop's geometry budget; a slower driver falls back instead of blocking
// the job.
const dispatchGeometryTimeout = 3 * time.Second

// resolveDispatchGeometry implements the print-time geometry policy: a
// job is never refused merely because measuring the driver is slow or
// failing. Preference order:
//
//  1. The last background-measured geometry whose fingerprint matches the
//     geometry the job was rendered for (the normal case — the renderer
//     used this same reported geometry).
//  2. A fresh live measurement, bounded by dispatchGeometryTimeout. A
//     fingerprint drift here is logged as an advisory; the job prints
//     with the measured size.
//  3. The last known geometry, whatever its fingerprint: printing at the
//     last known size beats refusing the job.
//  4. The configured geometry profile: the declared default size.
//
// Only when no geometry exists anywhere does it return an error, with
// the live measurement failure included so the refusal reason is explicit
// in the job record and the log.
func (a *Agent) resolveDispatchGeometry(ctx context.Context, id string, backend printer.Printer, pc config.PrinterConfig, fingerprint string) (*printer.Geometry, error) {
	cached := a.observations.geometryFor(id)
	if cached != nil && (fingerprint == "" || cached.CheckImageFingerprint(fingerprint) == nil) {
		return cached, nil
	}
	measureCtx, cancel := context.WithTimeout(ctx, dispatchGeometryTimeout)
	live, liveErr := printer.CurrentGeometry(measureCtx, backend, pc)
	cancel()
	if liveErr == nil && live != nil {
		a.observations.record(id, live, nil, "")
		if fingerprint != "" {
			if ferr := live.CheckImageFingerprint(fingerprint); ferr != nil {
				log.Printf("Printer %s: geometry advisory: %v; printing with the freshly measured geometry instead of refusing the job", id, ferr)
			}
		}
		return live, nil
	}
	if cached != nil {
		log.Printf("Printer %s: live geometry measurement failed (%v); printing with the last known geometry from background measurement", id, liveErr)
		return cached, nil
	}
	if configured, err := printer.ConfiguredGeometry(pc); err == nil && configured != nil {
		log.Printf("Printer %s: live geometry measurement failed (%v) and no cached geometry exists; printing with the configured default geometry profile", id, liveErr)
		return withDefaultImageMetrics(pc, configured), nil
	}
	return nil, fmt.Errorf("no geometry available for printer %s: live measurement failed (%v), no cached geometry, and no valid configured profile", id, liveErr)
}
