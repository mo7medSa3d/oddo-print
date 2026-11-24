package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// geometryBackend is a dispatch backend whose geometry measurement can be
// switched between a fixed result and a hard failure, simulating a slow
// or broken Windows driver at print time.
type geometryBackend struct {
	target   *fakePrinter
	geometry *printer.Geometry
	err      error
}

func (p *geometryBackend) Print(ctx context.Context, data []byte) error {
	return p.target.Print(ctx, data)
}
func (p *geometryBackend) Test(context.Context) error { return nil }
func (p *geometryBackend) Status() string             { return "online" }
func (p *geometryBackend) PrinterGeometry(context.Context) (*printer.Geometry, error) {
	return p.geometry, p.err
}

func resolverTestConfig() config.PrinterConfig {
	return config.PrinterConfig{ID: "printer_resolver_test", Name: "Resolver", Type: "network", Endpoint: "10.0.0.20:9100", Protocol: "raw"}
}

func measuredGeometry(t *testing.T, cfg config.PrinterConfig, widthDots int) *printer.Geometry {
	t.Helper()
	g, err := printer.NewGeometry(cfg, config.GeometryProfile{PrintableWidthDots: widthDots}, "windows_driver", "observed", "test-observation")
	if err != nil {
		t.Fatalf("NewGeometry: %v", err)
	}
	return g
}

func TestResolveDispatchGeometryPrefersCachedMatchingFingerprint(t *testing.T) {
	cfg := resolverTestConfig()
	cached := measuredGeometry(t, cfg, 576)
	a := &Agent{observations: newObservationCache()}
	a.observations.record(cfg.ID, cached, nil, "")
	backend := &geometryBackend{target: &fakePrinter{}, err: errors.New("driver measurement unavailable")}
	got, err := a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, cached.ConfigFingerprint)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != cached {
		t.Fatal("expected the cached background geometry, not a live measurement")
	}
}

func TestResolveDispatchGeometryFallsBackToLastKnownWhenLiveFails(t *testing.T) {
	cfg := resolverTestConfig()
	cached := measuredGeometry(t, cfg, 576)
	other := measuredGeometry(t, cfg, 512)
	a := &Agent{observations: newObservationCache()}
	a.observations.record(cfg.ID, cached, nil, "")
	backend := &geometryBackend{target: &fakePrinter{}, err: errors.New("driver measurement timed out")}
	// The job was rendered for a different (older) geometry: the drift is
	// advisory only, and the last known size is used instead of refusing.
	got, err := a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, other.ConfigFingerprint)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != cached {
		t.Fatal("expected fallback to the last known geometry when live measurement fails")
	}
}

func TestResolveDispatchGeometryFallsBackToConfiguredProfile(t *testing.T) {
	cfg := resolverTestConfig()
	profile := config.GeometryProfile{PrintableWidthDots: 640}
	cfg.GeometryProfile = &profile
	a := &Agent{observations: newObservationCache()}
	backend := &geometryBackend{target: &fakePrinter{}, err: errors.New("driver measurement unavailable")}
	got, err := a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got == nil || got.Source != "validated_profile" || got.PrintableWidthDots != 640 {
		t.Fatalf("expected the configured default geometry profile, got %+v", got)
	}
}

func TestResolveDispatchGeometryFailsOnlyWhenNothingIsAvailable(t *testing.T) {
	cfg := resolverTestConfig()
	a := &Agent{observations: newObservationCache()}
	backend := &geometryBackend{target: &fakePrinter{}, err: errors.New("driver measurement unavailable")}
	_, err := a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, "")
	if err == nil || !strings.Contains(err.Error(), "no geometry available") {
		t.Fatalf("expected an explicit no-geometry error, got %v", err)
	}
}

func TestResolveDispatchGeometryCachesLiveMeasurement(t *testing.T) {
	cfg := resolverTestConfig()
	live := measuredGeometry(t, cfg, 576)
	backend := &geometryBackend{target: &fakePrinter{}, geometry: live}
	a := &Agent{observations: newObservationCache()}
	got, err := a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, live.ConfigFingerprint)
	if err != nil || got != live {
		t.Fatalf("resolve live: got %v, err %v", got, err)
	}
	backend.err = errors.New("driver now failing")
	backend.geometry = nil
	got, err = a.resolveDispatchGeometry(context.Background(), cfg.ID, backend, cfg, live.ConfigFingerprint)
	if err != nil || got != live {
		t.Fatalf("expected the previously measured geometry from cache, got %v, err %v", got, err)
	}
}

func TestConfiguredFallbackGeometryGetsDefaultImageMetrics(t *testing.T) {
	// A spooler printer whose configured profile declares only a printable
	// width must still print image jobs: the resolver's configured fallback
	// synthesizes the standard default DPI and a derived paper width.
	spoolerCfg := resolverTestConfig()
	spoolerCfg.Type = "spooler"
	spoolerCfg.Protocol = "spooler"
	spoolerCfg.SpoolerName = "Queue"
	spoolerCfg.Endpoint = "Queue"
	profile := config.GeometryProfile{PrintableWidthDots: 576}
	spoolerCfg.GeometryProfile = &profile
	backend := &geometryBackend{target: &fakePrinter{}, err: errors.New("driver measurement unavailable")}
	a := &Agent{observations: newObservationCache()}
	got, err := a.resolveDispatchGeometry(context.Background(), spoolerCfg.ID, backend, spoolerCfg, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !got.PhysicalImageReady() {
		t.Fatalf("configured spooler fallback must be image-ready after default metrics, got %+v", got)
	}
	if *got.DPIX != defaultRasterDPI || *got.DPIY != defaultRasterDPI {
		t.Fatalf("expected default %d DPI, got %v/%v", defaultRasterDPI, got.DPIX, got.DPIY)
	}
	// A geometry that already carries measured DPI/paper metrics (as every
	// real driver measurement does) is never rewritten.
	dpi := 300
	paper := 80.0
	measured, err := printer.NewGeometry(spoolerCfg, config.GeometryProfile{PrintableWidthDots: 576, DPIX: &dpi, DPIY: &dpi, PaperWidthMM: &paper}, "windows_driver", "observed", "test-observation")
	if err != nil {
		t.Fatalf("NewGeometry measured: %v", err)
	}
	if out := withDefaultImageMetrics(spoolerCfg, measured); out != measured {
		t.Fatal("measured geometry must pass through untouched")
	}
	// Non-spooler printers keep their configured geometry as declared.
	netCfg := resolverTestConfig()
	if out := withDefaultImageMetrics(netCfg, measured); out != measured {
		t.Fatal("non-spooler geometry must pass through untouched")
	}
}

func TestVerificationAdvisory(t *testing.T) {
	cache := newObservationCache()
	if advisory := cache.verificationAdvisory("p", time.Now()); advisory == "" {
		t.Fatal("a printer with no verification history must produce an advisory")
	}
	cache.record("p", nil, nil, "driver measurement timed out")
	if advisory := cache.verificationAdvisory("p", time.Now()); !strings.Contains(advisory, "driver measurement timed out") {
		t.Fatalf("advisory must carry the background failure reason, got %q", advisory)
	}
	fresh := &printer.OperationalVerification{VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	cache.record("p", nil, fresh, "")
	if advisory := cache.verificationAdvisory("p", time.Now()); advisory != "" {
		t.Fatalf("a fresh proof must produce no advisory, got %q", advisory)
	}
	stale := &printer.OperationalVerification{VerifiedAt: time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339Nano)}
	cache.record("p", nil, stale, "")
	if advisory := cache.verificationAdvisory("p", time.Now()); !strings.Contains(advisory, "stale") {
		t.Fatalf("a stale proof must produce a stale advisory, got %q", advisory)
	}
}

func TestVerifyPrinterForDispatchHardFencesOnly(t *testing.T) {
	physical := &fakePrinter{}
	a := newTestAgent(t, "p", physical)
	pc := a.printerConfigs["p"]
	binding := testPrinterBinding(pc)

	// No verification implementation on the backend and no background
	// proof at all: dispatch proceeds (advisory only).
	if err := a.verifyPrinterForDispatch(context.Background(), "p", physical, pc, binding); err != nil {
		t.Fatalf("dispatch must proceed without any verification proof, got %v", err)
	}
	// A provably different destination binding remains a hard refusal.
	if err := a.verifyPrinterForDispatch(context.Background(), "p", physical, pc, strings.Repeat("b", 64)); err == nil {
		t.Fatal("a provably changed destination binding must still refuse dispatch")
	}
	// Identity collision remains a hard refusal.
	collided := pc
	collided.Capabilities = map[string]interface{}{"identity_collision": "duplicate"}
	a.printerConfigs["p"] = collided
	if err := a.verifyPrinterForDispatch(context.Background(), "p", physical, collided, binding); err == nil {
		t.Fatal("an identity collision must still refuse dispatch")
	}
	// Inventory absence remains a hard refusal.
	absent := pc
	absent.Capabilities = map[string]interface{}{"inventory_present": false}
	a.printerConfigs["p"] = absent
	if err := a.verifyPrinterForDispatch(context.Background(), "p", physical, absent, binding); err == nil {
		t.Fatal("an inventory-absent printer must still refuse dispatch")
	}
}
