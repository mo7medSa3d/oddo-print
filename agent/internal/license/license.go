package license

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// PinnedPublicKeyB64 is optionally injected at build time via:
// -ldflags "-X github.com/yaseir-agent/agent/internal/license.PinnedPublicKeyB64=..."
var PinnedPublicKeyB64 = ""

var (
	ErrInvalidBundle        = errors.New("invalid license bundle")
	ErrInvalidSignature     = errors.New("invalid license signature")
	ErrDBUUIDMismatch       = errors.New("license odoo_db_uuid mismatch")
	ErrLicenseExpired       = errors.New("license expired past grace period")
	ErrLicenseRevoked       = errors.New("license revoked")
	ErrLicenseRollback      = errors.New("license revision rollback rejected")
	ErrLicenseRequired      = errors.New("valid license required")
	ErrClockRollback        = errors.New("system clock rollback detected")
	ErrPublicKeyMissing     = errors.New("license public key not configured")
	ErrPrinterLimitExceeded = errors.New("license max_printers limit exceeded")
)

// DegradedReasonForError maps a license, clock, or verification error into a
// stable structured warning code used when POS printing fails open.
func DegradedReasonForError(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, ErrPublicKeyMissing):
		return "pos_degraded_public_key_missing"
	case errors.Is(err, ErrClockRollback):
		return "pos_degraded_clock_rollback"
	case errors.Is(err, ErrLicenseRevoked):
		return "pos_degraded_license_revoked"
	case errors.Is(err, ErrLicenseExpired):
		return "pos_degraded_license_expired"
	case errors.Is(err, ErrLicenseRequired):
		return "pos_degraded_license_required"
	case errors.Is(err, ErrInvalidSignature):
		return "pos_degraded_invalid_signature"
	case errors.Is(err, ErrInvalidBundle):
		return "pos_degraded_invalid_bundle"
	case errors.Is(err, ErrDBUUIDMismatch):
		return "pos_degraded_db_uuid_mismatch"
	case errors.Is(err, ErrLicenseRollback):
		return "pos_degraded_license_rollback"
	case errors.Is(err, ErrPrinterLimitExceeded):
		return "pos_degraded_printer_limit_exceeded"
	default:
		return "pos_degraded_verification_error"
	}
}

// devUnlicensedAllowed permits unlicensed printing only in unpinned dev builds
// when explicitly opted in via YASEIR_DEV_ALLOW_UNLICENSED=1.
func devUnlicensedAllowed() bool {
	return strings.TrimSpace(PinnedPublicKeyB64) == "" && strings.TrimSpace(os.Getenv("YASEIR_DEV_ALLOW_UNLICENSED")) == "1"
}

type Claims struct {
	Version     int      `json:"version"`
	LicenseID   string   `json:"license_id"`
	TenantID    string   `json:"tenant_id"`
	OdooDBUUID  string   `json:"odoo_db_uuid"`
	Plan        string   `json:"plan"`
	MaxAgents   int      `json:"max_agents"`
	MaxPrinters int      `json:"max_printers"`
	IssuedAt    string   `json:"issued_at"`
	ExpiresAt   string   `json:"expires_at"`
	GraceUntil  string   `json:"grace_until"`
	Status      string   `json:"status,omitempty"`
	Rev         int64    `json:"rev,omitempty"`
	KeyID       string   `json:"key_id,omitempty"`
	Features    []string `json:"features,omitempty"`
}

// canonicalClaims preserves alphabetical key order for v1 (10 fields) to match Node license-signer.ts.
type canonicalClaims struct {
	ExpiresAt   string `json:"expires_at"`
	GraceUntil  string `json:"grace_until"`
	IssuedAt    string `json:"issued_at"`
	LicenseID   string `json:"license_id"`
	MaxAgents   int    `json:"max_agents"`
	MaxPrinters int    `json:"max_printers"`
	OdooDBUUID  string `json:"odoo_db_uuid"`
	Plan        string `json:"plan"`
	TenantID    string `json:"tenant_id"`
	Version     int    `json:"version"`
}

// canonicalClaimsV2 preserves alphabetical key order for v2 (14 fields) to match Node license-signer.ts.
type canonicalClaimsV2 struct {
	ExpiresAt   string   `json:"expires_at"`
	Features    []string `json:"features"`
	GraceUntil  string   `json:"grace_until"`
	IssuedAt    string   `json:"issued_at"`
	KeyID       string   `json:"key_id"`
	LicenseID   string   `json:"license_id"`
	MaxAgents   int      `json:"max_agents"`
	MaxPrinters int      `json:"max_printers"`
	OdooDBUUID  string   `json:"odoo_db_uuid"`
	Plan        string   `json:"plan"`
	Rev         int64    `json:"rev"`
	Status      string   `json:"status"`
	TenantID    string   `json:"tenant_id"`
	Version     int      `json:"version"`
}

type Bundle struct {
	Payload   Claims `json:"payload"`
	Signature string `json:"signature"`
}

type VerifyOptions struct {
	ExpectedDBUUID string
	MinRev         int64
	Now            time.Time
}

// canonicalPayloadBytes serializes claims without HTML escaping so the bytes match
// Node's JSON.stringify byte-for-byte for both v1 and v2 schemas.
func canonicalPayloadBytes(c Claims) ([]byte, error) {
	var target any
	switch c.Version {
	case 1:
		target = canonicalClaims{
			ExpiresAt:   c.ExpiresAt,
			GraceUntil:  c.GraceUntil,
			IssuedAt:    c.IssuedAt,
			LicenseID:   c.LicenseID,
			MaxAgents:   c.MaxAgents,
			MaxPrinters: c.MaxPrinters,
			OdooDBUUID:  c.OdooDBUUID,
			Plan:        c.Plan,
			TenantID:    c.TenantID,
			Version:     c.Version,
		}
	case 2:
		features := c.Features
		if features == nil {
			features = []string{}
		}
		target = canonicalClaimsV2{
			ExpiresAt:   c.ExpiresAt,
			Features:    features,
			GraceUntil:  c.GraceUntil,
			IssuedAt:    c.IssuedAt,
			KeyID:       c.KeyID,
			LicenseID:   c.LicenseID,
			MaxAgents:   c.MaxAgents,
			MaxPrinters: c.MaxPrinters,
			OdooDBUUID:  c.OdooDBUUID,
			Plan:        c.Plan,
			Rev:         c.Rev,
			Status:      c.Status,
			TenantID:    c.TenantID,
			Version:     c.Version,
		}
	default:
		return nil, ErrInvalidBundle
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(target); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// DecodePublicKeyB64 decodes an Ed25519 public key from standard or URL-safe base64.
func DecodePublicKeyB64(raw string) (ed25519.PublicKey, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, fmt.Errorf("%w: empty public key", ErrInvalidBundle)
	}
	var pubBytes []byte
	var err error
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.RawURLEncoding,
		base64.URLEncoding,
	} {
		pubBytes, err = enc.DecodeString(s)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, fmt.Errorf("%w: invalid public key encoding", ErrInvalidBundle)
	}
	if len(pubBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: invalid public key length (%d)", ErrInvalidBundle, len(pubBytes))
	}
	return ed25519.PublicKey(pubBytes), nil
}

// ResolvePublicKey returns the pinned build-time Ed25519 public key, falling back to
// YASEIR_LICENSE_PUBLIC_KEY_B64. Returns (nil, false, nil) when enforcement is unconfigured.
func ResolvePublicKey() (ed25519.PublicKey, bool, error) {
	raw := strings.TrimSpace(PinnedPublicKeyB64)
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("YASEIR_LICENSE_PUBLIC_KEY_B64"))
	}
	if raw == "" {
		return nil, false, nil
	}
	pub, err := DecodePublicKeyB64(raw)
	if err != nil {
		return nil, true, err
	}
	return pub, true, nil
}

func VerifyBundleWithOptions(raw []byte, pubKey ed25519.PublicKey, opts VerifyOptions) (*Claims, bool, error) {
	if len(pubKey) != ed25519.PublicKeySize {
		return nil, false, ErrInvalidBundle
	}
	var b Bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	if (b.Payload.Version != 1 && b.Payload.Version != 2) || b.Payload.LicenseID == "" || b.Signature == "" {
		return nil, false, ErrInvalidBundle
	}
	if b.Payload.Version == 2 && b.Payload.Rev <= 0 {
		return nil, false, ErrInvalidBundle
	}
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(b.Signature, "="))
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrInvalidSignature, err)
	}
	canonical, err := canonicalPayloadBytes(b.Payload)
	if err != nil {
		return nil, false, err
	}
	if !ed25519.Verify(pubKey, canonical, sig) {
		return nil, false, ErrInvalidSignature
	}
	if opts.ExpectedDBUUID != "" && b.Payload.OdooDBUUID != opts.ExpectedDBUUID {
		return nil, false, ErrDBUUIDMismatch
	}
	if opts.MinRev > 0 && b.Payload.Rev < opts.MinRev {
		return nil, false, ErrLicenseRollback
	}
	if strings.EqualFold(strings.TrimSpace(b.Payload.Status), "revoked") {
		return &b.Payload, false, ErrLicenseRevoked
	}
	exp, err := time.Parse(time.RFC3339Nano, b.Payload.ExpiresAt)
	if err != nil {
		return nil, false, fmt.Errorf("%w: expires_at", ErrInvalidBundle)
	}
	grace, err := time.Parse(time.RFC3339Nano, b.Payload.GraceUntil)
	if err != nil {
		return nil, false, fmt.Errorf("%w: grace_until", ErrInvalidBundle)
	}
	if grace.Before(exp) {
		return nil, false, fmt.Errorf("%w: grace_until before expires_at", ErrInvalidBundle)
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.After(grace) {
		return &b.Payload, false, ErrLicenseExpired
	}
	return &b.Payload, now.After(exp), nil
}

// VerifyBundle validates a signed v1/v2 Ed25519 license bundle (backward-compatible wrapper).
func VerifyBundle(raw []byte, pubKey ed25519.PublicKey, expectedDBUUID string, now time.Time) (*Claims, bool, error) {
	return VerifyBundleWithOptions(raw, pubKey, VerifyOptions{
		ExpectedDBUUID: expectedDBUUID,
		Now:            now,
	})
}

// VerifyBundleFromEnv validates an offline Ed25519 license bundle when
// YASEIR_LICENSE_BUNDLE_PATH is configured. Unset path is a no-op for local/dev runs.
func VerifyBundleFromEnv() (bool, error) {
	bundlePath := strings.TrimSpace(os.Getenv("YASEIR_LICENSE_BUNDLE_PATH"))
	if bundlePath == "" {
		return false, nil
	}
	pub, configured, err := ResolvePublicKey()
	if err != nil {
		return false, err
	}
	if !configured {
		return false, fmt.Errorf("%w: YASEIR_LICENSE_PUBLIC_KEY_B64 is required", ErrInvalidBundle)
	}
	raw, err := os.ReadFile(bundlePath)
	if err != nil {
		return false, fmt.Errorf("read license bundle: %w", err)
	}
	_, inGrace, err := VerifyBundle(raw, pub, strings.TrimSpace(os.Getenv("YASEIR_ODOO_DB_UUID")), time.Now().UTC())
	return inGrace, err
}
