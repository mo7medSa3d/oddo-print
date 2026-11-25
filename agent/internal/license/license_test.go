package license

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func signTestBundle(t *testing.T, priv ed25519.PrivateKey, claims Claims) []byte {
	t.Helper()
	canonical, err := canonicalPayloadBytes(claims)
	if err != nil {
		t.Fatalf("canonicalPayloadBytes: %v", err)
	}
	raw, err := json.Marshal(Bundle{
		Payload:   claims,
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, canonical)),
	})
	if err != nil {
		t.Fatalf("json.Marshal bundle: %v", err)
	}
	return raw
}

func TestVerifyBundle(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	claims := Claims{
		Version:     1,
		LicenseID:   "sub_1",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
	}
	raw := signTestBundle(t, priv, claims)

	now, _ := time.Parse(time.RFC3339, "2026-11-20T00:00:00Z")
	got, inGrace, err := VerifyBundle(raw, pub, "db-uuid-123", now)
	if err != nil || inGrace || got.MaxPrinters != 15 {
		t.Fatalf("expected valid license, got=%+v inGrace=%v err=%v", got, inGrace, err)
	}

	graceTime, _ := time.Parse(time.RFC3339, "2026-12-03T00:00:00Z")
	if _, inGrace, err := VerifyBundle(raw, pub, "db-uuid-123", graceTime); err != nil || !inGrace {
		t.Fatalf("expected grace period active, inGrace=%v err=%v", inGrace, err)
	}

	expiredTime, _ := time.Parse(time.RFC3339, "2026-12-09T00:00:00Z")
	if _, _, err := VerifyBundle(raw, pub, "db-uuid-123", expiredTime); !errors.Is(err, ErrLicenseExpired) {
		t.Fatalf("expected ErrLicenseExpired, got %v", err)
	}

	if _, _, err := VerifyBundle(raw, pub, "wrong-db", now); !errors.Is(err, ErrDBUUIDMismatch) {
		t.Fatalf("expected ErrDBUUIDMismatch, got %v", err)
	}
}

func TestVerifyBundleV2RevocationAndRollback(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	now, _ := time.Parse(time.RFC3339, "2026-11-20T00:00:00Z")

	v2Active := Claims{
		Version:     2,
		LicenseID:   "sub_2",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "enterprise",
		MaxAgents:   20,
		MaxPrinters: 100,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         5,
		KeyID:       "key-2026-1",
		Features:    []string{"ws", "pos"},
	}
	rawActive := signTestBundle(t, priv, v2Active)

	got, inGrace, err := VerifyBundleWithOptions(rawActive, pub, VerifyOptions{
		ExpectedDBUUID: "db-uuid-123",
		MinRev:         5,
		Now:            now,
	})
	if err != nil || inGrace || got.Rev != 5 || got.KeyID != "key-2026-1" {
		t.Fatalf("expected valid v2 license, got=%+v inGrace=%v err=%v", got, inGrace, err)
	}

	if _, _, err := VerifyBundleWithOptions(rawActive, pub, VerifyOptions{
		ExpectedDBUUID: "db-uuid-123",
		MinRev:         6,
		Now:            now,
	}); !errors.Is(err, ErrLicenseRollback) {
		t.Fatalf("expected ErrLicenseRollback, got %v", err)
	}

	v2Revoked := v2Active
	v2Revoked.Status = "revoked"
	v2Revoked.Rev = 6
	rawRevoked := signTestBundle(t, priv, v2Revoked)
	if _, _, err := VerifyBundleWithOptions(rawRevoked, pub, VerifyOptions{
		ExpectedDBUUID: "db-uuid-123",
		MinRev:         5,
		Now:            now,
	}); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("expected ErrLicenseRevoked, got %v", err)
	}
}

func TestRuntimeGuardAntiRollbackAndClockRollback(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	statePath := filepath.Join(t.TempDir(), "license_state.json")
	guard := NewRuntimeGuard(pub, statePath)

	t0, _ := time.Parse(time.RFC3339, "2026-11-20T12:00:00Z")
	if err := guard.CheckPrintAllowed(t0); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected ErrLicenseRequired before bundle applied, got %v", err)
	}

	rev3 := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_2",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         3,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(rev3, "db-uuid-123", t0); err != nil {
		t.Fatalf("ApplyBundle rev3 failed: %v", err)
	}
	if err := guard.CheckPrintAllowed(t0.Add(time.Minute)); err != nil {
		t.Fatalf("expected print allowed, got %v", err)
	}

	// Clock rollback > 5m must be rejected.
	if err := guard.CheckPrintAllowed(t0.Add(-10 * time.Minute)); !errors.Is(err, ErrClockRollback) {
		t.Fatalf("expected ErrClockRollback, got %v", err)
	}

	// Older bundle replay must be rejected.
	rev2 := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_2",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         2,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(rev2, "db-uuid-123", t0.Add(2*time.Minute)); !errors.Is(err, ErrLicenseRollback) {
		t.Fatalf("expected ErrLicenseRollback for rev2 replay, got %v", err)
	}

	// Revocation tombstone clears active grant immediately and persists across restart.
	rev4Revoked := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_2",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "revoked",
		Rev:         4,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(rev4Revoked, "db-uuid-123", t0.Add(3*time.Minute)); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("expected ErrLicenseRevoked on tombstone, got %v", err)
	}
	if err := guard.CheckPrintAllowed(t0.Add(4 * time.Minute)); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("expected ErrLicenseRevoked after tombstone, got %v", err)
	}

	// Reload from disk and verify tombstone & highestRev survived restart.
	reloaded := NewRuntimeGuard(pub, statePath)
	if err := reloaded.CheckPrintAllowed(t0.Add(5 * time.Minute)); !errors.Is(err, ErrLicenseRevoked) {
		t.Fatalf("expected persisted ErrLicenseRevoked after reload, got %v", err)
	}
	if _, _, err := reloaded.ApplyBundle(rev3, "db-uuid-123", t0.Add(6*time.Minute)); !errors.Is(err, ErrLicenseRollback) {
		t.Fatalf("expected ErrLicenseRollback after reload, got %v", err)
	}
}

func TestRuntimeGuardCorruptStateRecovery(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	statePath := filepath.Join(t.TempDir(), "license_state.json")
	if err := os.WriteFile(statePath, []byte("{corrupt-json"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	guard := NewRuntimeGuard(pub, statePath)
	t0, _ := time.Parse(time.RFC3339, "2026-11-20T12:00:00Z")
	if err := guard.CheckPrintAllowed(t0); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected fail-closed ErrLicenseRequired on corrupt state, got %v", err)
	}

	bundle := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_corrupt_recover",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         1,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(bundle, "db-uuid-123", t0); err != nil {
		t.Fatalf("ApplyBundle recovery failed: %v", err)
	}
	if err := guard.CheckPrintAllowed(t0.Add(time.Minute)); err != nil {
		t.Fatalf("expected print allowed after recovery, got %v", err)
	}
}

func TestRuntimeGuardFailClosedAndDevOptIn(t *testing.T) {
	t.Setenv("YASEIR_DEV_ALLOW_UNLICENSED", "")
	t0, _ := time.Parse(time.RFC3339, "2026-11-20T12:00:00Z")
	statePath := filepath.Join(t.TempDir(), "license_state.json")

	var nilGuard *RuntimeGuard
	if err := nilGuard.CheckPrintAllowed(t0); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected ErrLicenseRequired for nil guard, got %v", err)
	}
	if _, _, err := nilGuard.ApplyBundle([]byte("{}"), "db-1", t0); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected ErrLicenseRequired for nil ApplyBundle, got %v", err)
	}
	if err := nilGuard.CheckPrinterLimit(1); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected ErrLicenseRequired for nil CheckPrinterLimit, got %v", err)
	}

	unconfigured := NewRuntimeGuard(nil, statePath)
	if err := unconfigured.CheckPrintAllowed(t0); !errors.Is(err, ErrPublicKeyMissing) {
		t.Fatalf("expected ErrPublicKeyMissing when pubKey is nil, got %v", err)
	}
	if _, _, err := unconfigured.ApplyBundle([]byte("{}"), "db-1", t0); !errors.Is(err, ErrPublicKeyMissing) {
		t.Fatalf("expected ErrPublicKeyMissing for unconfigured ApplyBundle, got %v", err)
	}
	if err := unconfigured.CheckPrinterLimit(1); !errors.Is(err, ErrPublicKeyMissing) {
		t.Fatalf("expected ErrPublicKeyMissing for unconfigured CheckPrinterLimit, got %v", err)
	}

	// Explicit dev opt-in works only when PinnedPublicKeyB64 is empty.
	t.Setenv("YASEIR_DEV_ALLOW_UNLICENSED", "1")
	if err := unconfigured.CheckPrintAllowed(t0); err != nil {
		t.Fatalf("expected dev opt-in to allow unpinned guard, got %v", err)
	}
	if err := nilGuard.CheckPrintAllowed(t0); err != nil {
		t.Fatalf("expected dev opt-in to allow nil guard when unpinned, got %v", err)
	}
	if err := unconfigured.CheckPrinterLimit(5); err != nil {
		t.Fatalf("expected dev opt-in to allow printer limit check when unpinned, got %v", err)
	}

	prevPinned := PinnedPublicKeyB64
	PinnedPublicKeyB64 = "cGlubmVkLWtleS1mb3ItcmVsZWFzZS1idWlsZA=="
	defer func() { PinnedPublicKeyB64 = prevPinned }()
	if err := unconfigured.CheckPrintAllowed(t0); !errors.Is(err, ErrPublicKeyMissing) {
		t.Fatalf("expected pinned release build to ignore YASEIR_DEV_ALLOW_UNLICENSED, got %v", err)
	}
	if err := nilGuard.CheckPrintAllowed(t0); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected pinned release build nil guard to ignore YASEIR_DEV_ALLOW_UNLICENSED, got %v", err)
	}
}

func TestRuntimeGuardCheckPrinterLimit(t *testing.T) {
	t.Setenv("YASEIR_DEV_ALLOW_UNLICENSED", "")
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	statePath := filepath.Join(t.TempDir(), "license_state.json")
	guard := NewRuntimeGuard(pub, statePath)
	t0, _ := time.Parse(time.RFC3339, "2026-11-20T12:00:00Z")

	if err := guard.CheckPrinterLimit(1); !errors.Is(err, ErrLicenseRequired) {
		t.Fatalf("expected ErrLicenseRequired before bundle applied, got %v", err)
	}

	bundle := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_limit",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "starter",
		MaxAgents:   2,
		MaxPrinters: 3,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         1,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(bundle, "db-uuid-123", t0); err != nil {
		t.Fatalf("ApplyBundle failed: %v", err)
	}
	if err := guard.CheckPrinterLimit(3); err != nil {
		t.Fatalf("expected 3 printers within limit 3 to pass, got %v", err)
	}
	if err := guard.CheckPrinterLimit(4); !errors.Is(err, ErrPrinterLimitExceeded) {
		t.Fatalf("expected ErrPrinterLimitExceeded for 4 > 3, got %v", err)
	}

	unlimited := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_limit",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "enterprise",
		MaxAgents:   0,
		MaxPrinters: 0,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         2,
		KeyID:       "k1",
	})
	if _, _, err := guard.ApplyBundle(unlimited, "db-uuid-123", t0.Add(time.Minute)); err != nil {
		t.Fatalf("ApplyBundle unlimited failed: %v", err)
	}
	if err := guard.CheckPrinterLimit(100); err != nil {
		t.Fatalf("expected MaxPrinters=0 to allow unlimited printers, got %v", err)
	}
}

func TestRuntimeGuardApplyBundleFromEnv(t *testing.T) {
	t.Setenv("YASEIR_DEV_ALLOW_UNLICENSED", "")
	t.Setenv("YASEIR_ODOO_DB_UUID", "db-uuid-env")
	t.Setenv("YASEIR_LICENSE_BUNDLE_PATH", "")

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	dir := t.TempDir()
	guard := NewRuntimeGuard(pub, filepath.Join(dir, "license_state.json"))

	// Unset env is a no-op.
	if err := guard.ApplyBundleFromEnv(); err != nil {
		t.Fatalf("expected nil when YASEIR_LICENSE_BUNDLE_PATH is unset, got %v", err)
	}

	// Missing file fails closed.
	t.Setenv("YASEIR_LICENSE_BUNDLE_PATH", filepath.Join(dir, "missing.json"))
	if err := guard.ApplyBundleFromEnv(); err == nil {
		t.Fatal("expected error when YASEIR_LICENSE_BUNDLE_PATH points to missing file")
	}

	// Valid bundle file succeeds and unlocks CheckPrintAllowed.
	now := time.Now().UTC()
	bundle := signTestBundle(t, priv, Claims{
		Version:     2,
		LicenseID:   "sub_env",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-env",
		Plan:        "pro",
		MaxAgents:   2,
		MaxPrinters: 5,
		IssuedAt:    now.Add(-time.Hour).Format(time.RFC3339),
		ExpiresAt:   now.Add(24 * time.Hour).Format(time.RFC3339),
		GraceUntil:  now.Add(48 * time.Hour).Format(time.RFC3339),
		Status:      "active",
		Rev:         1,
		KeyID:       "k1",
	})
	bundlePath := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(bundlePath, bundle, 0600); err != nil {
		t.Fatalf("WriteFile bundle: %v", err)
	}
	t.Setenv("YASEIR_LICENSE_BUNDLE_PATH", bundlePath)
	if err := guard.ApplyBundleFromEnv(); err != nil {
		t.Fatalf("ApplyBundleFromEnv valid bundle failed: %v", err)
	}
	if err := guard.CheckPrintAllowed(now); err != nil {
		t.Fatalf("expected CheckPrintAllowed to pass after ApplyBundleFromEnv, got %v", err)
	}

	// Unconfigured guard (nil public key) fails closed on ApplyBundleFromEnv.
	unconfigured := NewRuntimeGuard(nil, filepath.Join(dir, "unconfigured_state.json"))
	if err := unconfigured.ApplyBundleFromEnv(); !errors.Is(err, ErrPublicKeyMissing) {
		t.Fatalf("expected ErrPublicKeyMissing for unconfigured guard, got %v", err)
	}
}

func TestVerifyBundleRejectsNonPositiveV2RevAndGraceBeforeExpiry(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	now, _ := time.Parse(time.RFC3339, "2026-11-20T00:00:00Z")

	zeroRev := Claims{
		Version:     2,
		LicenseID:   "sub_zero_rev",
		TenantID:    "ten_1",
		OdooDBUUID:  "db-uuid-123",
		Plan:        "pro",
		MaxAgents:   5,
		MaxPrinters: 15,
		IssuedAt:    "2026-11-17T00:00:00Z",
		ExpiresAt:   "2026-12-01T00:00:00Z",
		GraceUntil:  "2026-12-08T00:00:00Z",
		Status:      "active",
		Rev:         0,
		KeyID:       "k1",
	}
	if _, _, err := VerifyBundle(signTestBundle(t, priv, zeroRev), pub, "db-uuid-123", now); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("expected ErrInvalidBundle for v2 rev=0, got %v", err)
	}

	graceBeforeExp := zeroRev
	graceBeforeExp.Rev = 1
	graceBeforeExp.GraceUntil = "2026-11-30T00:00:00Z"
	if _, _, err := VerifyBundle(signTestBundle(t, priv, graceBeforeExp), pub, "db-uuid-123", now); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("expected ErrInvalidBundle when grace_until < expires_at, got %v", err)
	}
}

func TestDecodePublicKeyB64AcceptsRawSPKIAndPEM(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	spkiDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("MarshalPKIXPublicKey: %v", err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spkiDER})

	cases := []struct {
		name string
		raw  string
	}{
		{name: "raw32", raw: base64.StdEncoding.EncodeToString(pub)},
		{name: "spkiDER", raw: base64.StdEncoding.EncodeToString(spkiDER)},
		{name: "pem", raw: string(pemBlock)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, decErr := DecodePublicKeyB64(tc.raw)
			if decErr != nil {
				t.Fatalf("DecodePublicKeyB64(%s) unexpected error: %v", tc.name, decErr)
			}
			if !bytes.Equal(got, pub) {
				t.Fatalf("DecodePublicKeyB64(%s) mismatch", tc.name)
			}
		})
	}
}
