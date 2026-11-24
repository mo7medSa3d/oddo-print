package license

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

const (
	// maxClockRollbackSeconds tolerates minor NTP step adjustments while blocking clock-freeze/rollback attacks.
	maxClockRollbackSeconds int64 = 300
	clockPersistIntervalSec int64 = 60
)

type guardState struct {
	HighestRev      int64           `json:"highest_rev"`
	HighestSeenUnix int64           `json:"highest_seen_unix"`
	Revoked         bool            `json:"revoked"`
	RevokedRev      int64           `json:"revoked_rev,omitempty"`
	OdooDBUUID      string          `json:"odoo_db_uuid,omitempty"`
	LastBundle      json.RawMessage `json:"last_bundle,omitempty"`
}

// RuntimeGuard enforces Ed25519 license validity, revocation tombstones,
// monotonic revision anti-rollback, and system-clock anti-rollback.
type RuntimeGuard struct {
	mu                sync.RWMutex
	pubKey            ed25519.PublicKey
	statePath         string
	highestRev        int64
	highestSeenUnix   int64
	persistedSeenUnix int64
	revoked           bool
	revokedRev        int64
	expectedDBUUID    string
	active            *Claims
	activeGraceAt     time.Time
	lastBundle        json.RawMessage
}

// NewRuntimeGuard creates a guard backed by statePath (<dataDir>/license_state.json).
// When pubKey is nil or wrong length, enforcement fails closed unless an unpinned dev build sets YASEIR_DEV_ALLOW_UNLICENSED=1.
func NewRuntimeGuard(pubKey ed25519.PublicKey, statePath string) *RuntimeGuard {
	g := &RuntimeGuard{
		statePath: statePath,
	}
	if len(pubKey) == ed25519.PublicKeySize {
		g.pubKey = append(ed25519.PublicKey(nil), pubKey...)
	}
	g.loadStateLocked()
	return g
}

// NewRuntimeGuardFromConfig resolves the pinned or env Ed25519 public key and
// binds state persistence to <dataDir>/license_state.json.
func NewRuntimeGuardFromConfig(dataDir string) (*RuntimeGuard, error) {
	pub, _, err := ResolvePublicKey()
	if err != nil {
		return nil, err
	}
	statePath := ""
	if strings.TrimSpace(dataDir) != "" {
		statePath = filepath.Join(dataDir, "license_state.json")
	}
	return NewRuntimeGuard(pub, statePath), nil
}

// ApplyBundleFromEnv applies an offline signed license bundle from
// YASEIR_LICENSE_BUNDLE_PATH when configured. Returns nil when unset.
func (g *RuntimeGuard) ApplyBundleFromEnv() error {
	bundlePath := strings.TrimSpace(os.Getenv("YASEIR_LICENSE_BUNDLE_PATH"))
	if bundlePath == "" {
		return nil
	}
	raw, err := os.ReadFile(bundlePath)
	if err != nil {
		return err
	}
	_, _, err = g.ApplyBundle(raw, strings.TrimSpace(os.Getenv("YASEIR_ODOO_DB_UUID")), time.Now().UTC())
	return err
}

// Enforcing reports whether a valid Ed25519 public key is configured.
func (g *RuntimeGuard) Enforcing() bool {
	if g == nil {
		return false
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	return len(g.pubKey) == ed25519.PublicKeySize
}

// ApplyBundle verifies a signed license bundle, applies revocation tombstones
// immediately, rejects revision/clock rollbacks, and persists updated state.
func (g *RuntimeGuard) ApplyBundle(raw []byte, expectedDBUUID string, now time.Time) (*Claims, bool, error) {
	if g == nil {
		return nil, false, ErrLicenseRequired
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	nowUnix := now.Unix()

	g.mu.Lock()
	defer g.mu.Unlock()

	if len(g.pubKey) != ed25519.PublicKeySize {
		return nil, false, ErrPublicKeyMissing
	}
	if g.highestSeenUnix > 0 && nowUnix < g.highestSeenUnix-maxClockRollbackSeconds {
		return nil, false, ErrClockRollback
	}
	clockAdvanced := false
	if nowUnix > g.highestSeenUnix {
		g.highestSeenUnix = nowUnix
		clockAdvanced = true
	}

	dbUUID := strings.TrimSpace(expectedDBUUID)
	if dbUUID == "" {
		dbUUID = g.expectedDBUUID
	}

	claims, inGrace, err := VerifyBundleWithOptions(raw, g.pubKey, VerifyOptions{
		ExpectedDBUUID: dbUUID,
		MinRev:         g.highestRev,
		Now:            now,
	})
	if errors.Is(err, ErrLicenseRevoked) && claims != nil {
		g.active = nil
		g.activeGraceAt = time.Time{}
		g.lastBundle = nil
		g.revoked = true
		if claims.Rev > g.revokedRev {
			g.revokedRev = claims.Rev
		}
		if claims.Rev > g.highestRev {
			g.highestRev = claims.Rev
		}
		if dbUUID != "" {
			g.expectedDBUUID = dbUUID
		} else if claims.OdooDBUUID != "" {
			g.expectedDBUUID = claims.OdooDBUUID
		}
		_ = g.persistStateLocked()
		return claims, false, ErrLicenseRevoked
	}
	if err != nil {
		if clockAdvanced {
			_ = g.persistStateLocked()
		}
		return nil, false, err
	}

	// Do not allow an active bundle at the same revision as an already-recorded tombstone.
	if g.revoked && claims.Rev <= g.revokedRev {
		if clockAdvanced {
			_ = g.persistStateLocked()
		}
		return nil, false, ErrLicenseRevoked
	}

	grace, err := time.Parse(time.RFC3339Nano, claims.GraceUntil)
	if err != nil {
		return nil, false, ErrInvalidBundle
	}

	g.revoked = false
	if claims.Rev > g.highestRev {
		g.highestRev = claims.Rev
	}
	if dbUUID != "" {
		g.expectedDBUUID = dbUUID
	} else if claims.OdooDBUUID != "" {
		g.expectedDBUUID = claims.OdooDBUUID
	}
	copiedClaims := *claims
	if len(claims.Features) > 0 {
		copiedClaims.Features = append([]string(nil), claims.Features...)
	}
	g.active = &copiedClaims
	g.activeGraceAt = grace
	g.lastBundle = append(json.RawMessage(nil), raw...)
	_ = g.persistStateLocked()
	ret := copiedClaims
	if len(copiedClaims.Features) > 0 {
		ret.Features = append([]string(nil), copiedClaims.Features...)
	}
	return &ret, inGrace, nil
}

// CheckPrintAllowed verifies that printing is permitted under the active license
// and that the system clock has not rolled back more than 5 minutes.
func (g *RuntimeGuard) CheckPrintAllowed(now time.Time) error {
	if g == nil {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrLicenseRequired
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	nowUnix := now.Unix()

	g.mu.Lock()
	defer g.mu.Unlock()

	if len(g.pubKey) != ed25519.PublicKeySize {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrPublicKeyMissing
	}
	if g.highestSeenUnix > 0 && nowUnix < g.highestSeenUnix-maxClockRollbackSeconds {
		return ErrClockRollback
	}
	if nowUnix > g.highestSeenUnix {
		g.highestSeenUnix = nowUnix
		if g.persistedSeenUnix == 0 || nowUnix-g.persistedSeenUnix >= clockPersistIntervalSec {
			_ = g.persistStateLocked()
		}
	}
	if g.revoked {
		return ErrLicenseRevoked
	}
	if g.active == nil {
		return ErrLicenseRequired
	}
	if now.After(g.activeGraceAt) {
		return ErrLicenseExpired
	}
	return nil
}

// CheckPrintAllowedForJob verifies whether printing is permitted for a job.
// For non-POS jobs (isPOS == false), it enforces the full RuntimeGuard policy
// identically to CheckPrintAllowed.
// For POS jobs (isPOS == true), license, verification, clock, or sync errors
// NEVER block, break, or delay printing: it performs a non-blocking read-only
// check (no synchronous disk persistence), logs a structured degraded-mode
// warning, and returns (warningReason, nil).
func (g *RuntimeGuard) CheckPrintAllowedForJob(now time.Time, isPOS bool) (string, error) {
	if !isPOS {
		return "", g.CheckPrintAllowed(now)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	licErr := g.checkPrintStateReadOnly(now)
	if licErr == nil {
		return "", nil
	}
	reason := DegradedReasonForError(licErr)
	log.Printf("license.pos_degraded mode=fail_open reason=%s detail=%q", reason, licErr.Error())
	return reason, nil
}

// checkPrintStateReadOnly evaluates license state under RLock without disk I/O
// so POS receipt printing cannot be stalled by clock persistence or lock contention.
func (g *RuntimeGuard) checkPrintStateReadOnly(now time.Time) error {
	if g == nil {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrLicenseRequired
	}
	nowUnix := now.Unix()

	g.mu.RLock()
	defer g.mu.RUnlock()

	if len(g.pubKey) != ed25519.PublicKeySize {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrPublicKeyMissing
	}
	if g.highestSeenUnix > 0 && nowUnix < g.highestSeenUnix-maxClockRollbackSeconds {
		return ErrClockRollback
	}
	if g.revoked {
		return ErrLicenseRevoked
	}
	if g.active == nil {
		return ErrLicenseRequired
	}
	if now.After(g.activeGraceAt) {
		return ErrLicenseExpired
	}
	return nil
}

// CheckPrinterLimit enforces the active license's max_printers ceiling.
func (g *RuntimeGuard) CheckPrinterLimit(activePrinters int) error {
	if g == nil {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrLicenseRequired
	}
	g.mu.RLock()
	defer g.mu.RUnlock()

	if len(g.pubKey) != ed25519.PublicKeySize {
		if devUnlicensedAllowed() {
			return nil
		}
		return ErrPublicKeyMissing
	}
	if g.revoked {
		return ErrLicenseRevoked
	}
	if g.active == nil {
		return ErrLicenseRequired
	}
	if g.active.MaxPrinters > 0 && activePrinters > g.active.MaxPrinters {
		return ErrPrinterLimitExceeded
	}
	return nil
}

func (g *RuntimeGuard) loadStateLocked() {
	if g.statePath == "" {
		return
	}
	raw, err := os.ReadFile(g.statePath)
	if err != nil {
		return
	}
	var st guardState
	if err := json.Unmarshal(raw, &st); err != nil {
		return
	}
	if st.HighestRev > 0 {
		g.highestRev = st.HighestRev
	}
	if st.HighestSeenUnix > 0 {
		g.highestSeenUnix = st.HighestSeenUnix
		g.persistedSeenUnix = st.HighestSeenUnix
	}
	g.revoked = st.Revoked
	if st.RevokedRev > 0 {
		g.revokedRev = st.RevokedRev
	}
	g.expectedDBUUID = st.OdooDBUUID

	if len(g.pubKey) != ed25519.PublicKeySize || g.revoked || len(st.LastBundle) == 0 {
		return
	}
	now := time.Now().UTC()
	if g.highestSeenUnix > 0 && now.Unix() < g.highestSeenUnix-maxClockRollbackSeconds {
		return
	}
	claims, _, err := VerifyBundleWithOptions(st.LastBundle, g.pubKey, VerifyOptions{
		ExpectedDBUUID: g.expectedDBUUID,
		MinRev:         g.highestRev,
		Now:            now,
	})
	if err != nil {
		return
	}
	if g.revokedRev > 0 && claims.Rev <= g.revokedRev {
		return
	}
	grace, err := time.Parse(time.RFC3339Nano, claims.GraceUntil)
	if err != nil {
		return
	}
	g.active = claims
	g.activeGraceAt = grace
	g.lastBundle = append(json.RawMessage(nil), st.LastBundle...)
}

func (g *RuntimeGuard) persistStateLocked() error {
	if g.statePath == "" {
		return nil
	}
	st := guardState{
		HighestRev:      g.highestRev,
		HighestSeenUnix: g.highestSeenUnix,
		Revoked:         g.revoked,
		RevokedRev:      g.revokedRev,
		OdooDBUUID:      g.expectedDBUUID,
		LastBundle:      g.lastBundle,
	}
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	dir := filepath.Dir(g.statePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return err
	}
	tmpFile, err := os.CreateTemp(dir, ".license_state-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)
	if err := tmpFile.Chmod(0600); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(tmpPath); err != nil {
		return err
	}
	if err := config.ReplaceFile(tmpPath, g.statePath); err != nil {
		return err
	}
	if err := config.EnsureSecureFileACL(g.statePath); err != nil {
		return err
	}
	g.persistedSeenUnix = g.highestSeenUnix
	return nil
}
