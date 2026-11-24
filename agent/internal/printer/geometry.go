package printer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

// Geometry is bound to one destination and selected media/configuration.
// A configured profile is not evidence of physical hardware verification.
type Geometry struct {
	Version           int    `json:"version"`
	Source            string `json:"source"`
	Validation        string `json:"validation"`
	ObservedAt        string `json:"observed_at"`
	PrinterID         string `json:"printer_id"`
	ConfigFingerprint string `json:"config_fingerprint"`
	config.GeometryProfile
}

var geometryFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var geometryTimestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$`)

func geometryJSON(raw interface{}, snapshot bool) ([]byte, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return nil, fmt.Errorf("geometry must be an object")
	}
	allowed := map[string]bool{"printable_width_dots": true, "printable_height_dots": true, "dpi_x": true, "dpi_y": true, "paper_width_mm": true, "paper_height_mm": true, "offset_x_dots": true, "offset_y_dots": true, "raster_command": true}
	if snapshot {
		for _, key := range []string{"version", "source", "validation", "observed_at", "printer_id", "config_fingerprint"} {
			allowed[key] = true
		}
	}
	for key, value := range object {
		if !allowed[key] || bytes.Equal(value, []byte("null")) {
			return nil, fmt.Errorf("unsupported or null geometry field %s", key)
		}
		if key == "raster_command" && !bytes.Equal(value, []byte(`"gs_v_0"`)) {
			return nil, fmt.Errorf("geometry raster_command must be gs_v_0")
		}
	}
	return data, nil
}

func ValidateGeometryProfile(p config.GeometryProfile) error {
	if p.PrintableWidthDots < 1 || p.PrintableWidthDots > MaxJPEGDimension {
		return fmt.Errorf("geometry printable_width_dots must be 1..%d", MaxJPEGDimension)
	}
	for _, field := range []struct {
		name     string
		value    *int
		min, max int
	}{
		{"printable_height_dots", p.PrintableHeightDots, 1, 1000000},
		{"dpi_x", p.DPIX, 1, 9600}, {"dpi_y", p.DPIY, 1, 9600},
		{"offset_x_dots", p.OffsetXDots, 0, 1000000}, {"offset_y_dots", p.OffsetYDots, 0, 1000000},
	} {
		if field.value != nil && (*field.value < field.min || *field.value > field.max) {
			return fmt.Errorf("geometry %s must be %d..%d", field.name, field.min, field.max)
		}
	}
	for _, field := range []struct {
		name  string
		value *float64
	}{
		{"paper_width_mm", p.PaperWidthMM}, {"paper_height_mm", p.PaperHeightMM},
	} {
		if field.value != nil && (math.IsNaN(*field.value) || math.IsInf(*field.value, 0) || *field.value <= 0 || *field.value > 10000) {
			return fmt.Errorf("geometry %s must be finite and >0..10000", field.name)
		}
	}
	if p.RasterCommand != "" && p.RasterCommand != "gs_v_0" {
		return fmt.Errorf("geometry raster_command must be gs_v_0 when declared")
	}
	if p.PaperWidthMM != nil && p.DPIX != nil {
		offset := 0
		if p.OffsetXDots != nil {
			offset = *p.OffsetXDots
		}
		if float64(p.PrintableWidthDots+offset) > *p.PaperWidthMM*float64(*p.DPIX)/25.4+1.000000001 {
			return fmt.Errorf("geometry printable width and offset exceed physical paper width")
		}
	}
	if p.PaperHeightMM != nil && p.DPIY != nil {
		offset := 0
		if p.OffsetYDots != nil {
			offset = *p.OffsetYDots
		}
		height := 0
		if p.PrintableHeightDots != nil {
			height = *p.PrintableHeightDots
		}
		if float64(height+offset) > *p.PaperHeightMM*float64(*p.DPIY)/25.4+1.000000001 {
			return fmt.Errorf("geometry printable height and offset exceed physical paper height")
		}
	}
	return nil
}

func ParseGeometryProfile(raw interface{}) (*config.GeometryProfile, error) {
	data, err := geometryJSON(raw, false)
	if err != nil {
		return nil, fmt.Errorf("invalid geometry profile: %w", err)
	}
	var p config.GeometryProfile
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(&p); err != nil {
		return nil, fmt.Errorf("invalid geometry profile: %w", err)
	}
	if err = ValidateGeometryProfile(p); err != nil {
		return nil, err
	}
	return &p, nil
}

// NewGeometry excludes observation time from the hash. Changed destinations,
// protocol, media or measurements invalidate previously rendered image jobs.
func NewGeometry(cfg config.PrinterConfig, profile config.GeometryProfile, source, validation, observationKey string) (*Geometry, error) {
	if err := ValidateGeometryProfile(profile); err != nil {
		return nil, err
	}
	if !validGeometryPrinterID(cfg.ID) {
		return nil, fmt.Errorf("geometry requires a printer id")
	}
	if (source == "validated_profile" && validation != "configured") ||
		((source == "windows_driver" || source == "ipp") && validation != "observed") ||
		(source != "validated_profile" && source != "windows_driver" && source != "ipp") {
		return nil, fmt.Errorf("invalid geometry source/validation")
	}
	binding, err := config.PrinterBindingDigest(cfg)
	if err != nil {
		return nil, fmt.Errorf("geometry printer binding: %w", err)
	}
	encoded, err := json.Marshal(struct {
		Version                                       int
		ID, Binding, Protocol, Source, ObservationKey string
		Profile                                       config.GeometryProfile
	}{1, cfg.ID, binding, cfg.NormalizedProtocolOrUnknown(), source, observationKey, profile})
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(encoded)
	return &Geometry{Version: 1, Source: source, Validation: validation, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		PrinterID: cfg.ID, ConfigFingerprint: hex.EncodeToString(hash[:]), GeometryProfile: profile}, nil
}

func (g *Geometry) Validate() error {
	if g == nil {
		return fmt.Errorf("printer geometry is unknown; configure a measured geometry_profile")
	}
	if g.Version != 1 || !validGeometryPrinterID(g.PrinterID) || !geometryFingerprintPattern.MatchString(g.ConfigFingerprint) {
		return fmt.Errorf("invalid geometry identity or version")
	}
	if _, err := time.Parse(time.RFC3339Nano, g.ObservedAt); err != nil || !geometryTimestampPattern.MatchString(g.ObservedAt) {
		return fmt.Errorf("invalid geometry observed_at")
	}
	if (g.Source == "validated_profile" && g.Validation != "configured") ||
		((g.Source == "windows_driver" || g.Source == "ipp") && g.Validation != "observed") ||
		(g.Source != "validated_profile" && g.Source != "windows_driver" && g.Source != "ipp") {
		return fmt.Errorf("invalid geometry provenance")
	}
	return ValidateGeometryProfile(g.GeometryProfile)
}

func ParseGeometry(raw interface{}, printerID, fingerprint string) (*Geometry, error) {
	data, err := geometryJSON(raw, true)
	if err != nil {
		return nil, err
	}
	var g Geometry
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&g); err != nil {
		return nil, err
	}
	if err := g.Validate(); err != nil {
		return nil, err
	}
	if printerID != "" && g.PrinterID != printerID {
		return nil, fmt.Errorf("geometry printer identity does not match execution destination")
	}
	if fingerprint != "" && g.ConfigFingerprint != fingerprint {
		return nil, fmt.Errorf("geometry configuration fingerprint is stale")
	}
	return &g, nil
}

func GeometryFromCapabilities(caps map[string]interface{}) *Geometry {
	g, _ := ParseGeometry(caps["geometry"], "", "")
	return g
}

// ConfiguredGeometry adapts explicit dot measurements deliberately. Legacy
// <=128 max_paper_width is ambiguous millimetres, never a head-size inference.
func ConfiguredGeometry(cfg config.PrinterConfig) (*Geometry, error) {
	if cfg.GeometryProfile != nil {
		return NewGeometry(cfg, *cfg.GeometryProfile, "validated_profile", "configured", "operator_profile")
	}
	if !cfg.ExplicitLegacyGeometry {
		return nil, fmt.Errorf("printer geometry is unknown; observed legacy width is not a validated operator profile")
	}
	dots, explicit := capabilityInt(cfg.Capabilities["max_paper_width"])
	if !explicit {
		return nil, fmt.Errorf("printer geometry is unknown; configure geometry_profile with measured printable_width_dots")
	}
	if dots <= 128 || dots > MaxJPEGDimension {
		return nil, fmt.Errorf("legacy max_paper_width is ambiguous or outside limits; configure geometry_profile in measured dots")
	}
	p := config.GeometryProfile{PrintableWidthDots: dots}
	if command, ok := cfg.Capabilities["raster_command"].(string); ok {
		p.RasterCommand = command
	}
	value, present := cfg.Capabilities["print_dpi"]
	if !present {
		value, present = cfg.Capabilities["dpi"]
	}
	if present {
		dpi, ok := capabilityInt(value)
		if !ok || dpi < 1 || dpi > 9600 {
			return nil, fmt.Errorf("explicit legacy DPI must be 1..9600")
		}
		p.DPIX, p.DPIY = &dpi, &dpi
	}
	if cfg.PaperWidthMM > 0 {
		mm := float64(cfg.PaperWidthMM)
		p.PaperWidthMM = &mm
	}
	return NewGeometry(cfg, p, "validated_profile", "configured", "explicit_legacy_dot_profile")
}

func (g *Geometry) CheckImageFingerprint(fingerprint string) error {
	if err := g.Validate(); err != nil {
		return CapabilityMismatchf("%v", err)
	}
	if !geometryFingerprintPattern.MatchString(fingerprint) || fingerprint != g.ConfigFingerprint {
		return CapabilityMismatchf("image geometry_fingerprint is missing or stale; refresh printer geometry and render again before submitting")
	}
	return nil
}

type GeometryProvider interface {
	PrinterGeometry(context.Context) (*Geometry, error)
}

func CurrentGeometry(ctx context.Context, p Printer, cfg config.PrinterConfig) (*Geometry, error) {
	if provider, ok := p.(GeometryProvider); ok {
		return provider.PrinterGeometry(ctx)
	}
	return ConfiguredGeometry(cfg)
}

type dispatchGeometryKey struct{}

// WithDispatchGeometry carries the geometry the dispatch layer resolved
// for this job — background-cached, bounded live measurement, last known
// size, or configured default, in that preference order — into the
// backend print call. A backend that finds a dispatch geometry uses it
// as-is: dispatch already applied the fallback policy, so the backend
// must not re-measure and cannot fail the job on a measurement error the
// policy has already absorbed.
func WithDispatchGeometry(ctx context.Context, g *Geometry) context.Context {
	if g == nil {
		return ctx
	}
	return context.WithValue(ctx, dispatchGeometryKey{}, g)
}

// DispatchGeometry returns the geometry resolved by the dispatch layer,
// or nil when the caller did not resolve one (direct/backend calls keep
// their own measurement behavior).
func DispatchGeometry(ctx context.Context) *Geometry {
	g, _ := ctx.Value(dispatchGeometryKey{}).(*Geometry)
	return g
}

func validGeometryPrinterID(id string) bool {
	return ValidPrinterID(id)
}

func (g *Geometry) PhysicalImageReady() bool {
	return g.Validate() == nil && g.DPIX != nil && g.DPIY != nil && g.PaperWidthMM != nil
}

// PhysicalPageImageReady is required when a file has no live driver from
// which to obtain page height and margins. Explicit zero offsets are valid.
func (g *Geometry) PhysicalPageImageReady() bool {
	return g.PhysicalImageReady() && g.PaperHeightMM != nil && g.PrintableHeightDots != nil && g.OffsetXDots != nil && g.OffsetYDots != nil
}
