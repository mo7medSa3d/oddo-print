package printer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

var ErrPrinterUnverified = errors.New("PRINTER_UNVERIFIED")

// OperationalVerification proves a live, read-only transport/queue check. It
// never asserts that paper emerged, that a configured profile was measured,
// or that a queue/service identifier is a globally unique physical chassis.
type OperationalVerification struct {
	Version           int    `json:"version"`
	VerifiedAt        string `json:"verified_at"`
	PrinterID         string `json:"printer_id"`
	BindingDigest     string `json:"binding_digest"`
	Method            string `json:"method"`
	LogicalQueueKey   string `json:"logical_queue_key"`
	PhysicalDeviceKey string `json:"physical_device_key,omitempty"`
	IdentityStrength  string `json:"identity_strength"`
	OutputMedium      string `json:"output_medium"`
}

// Implementations must query the actual configured destination. Merely
// constructing a backend, opening TCP, or reading persisted capabilities is
// insufficient. Verification must never submit a test print.
type OperationalVerifier interface {
	VerifyOperational(context.Context, config.PrinterConfig) (*OperationalVerification, error)
}

func operationalMethod(cfg config.PrinterConfig) (method, strength, medium string) {
	protocol := cfg.NormalizedProtocolOrUnknown()
	switch cfg.NormalizedType() {
	case "spooler":
		return "windows_queue", "queue", "physical"
	case "usb":
		return "usb_interface", "device", "physical"
	case "ipp", "ipps":
		return "ipp_attributes", "service", "physical"
	case "network":
		if protocol == "ipp" || protocol == "ipps" {
			return "ipp_attributes", "service", "physical"
		}
		return "snmp_printer", "device", "physical"
	default:
		return "", "", ""
	}
}

func NewOperationalVerification(cfg config.PrinterConfig, method, identityStrength, physicalDeviceKey, outputMedium string) (*OperationalVerification, error) {
	binding, err := config.PrinterBindingDigest(cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid execution binding: %v", ErrPrinterUnverified, err)
	}
	proof := &OperationalVerification{Version: 1, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano),
		PrinterID: cfg.ID, BindingDigest: binding, Method: method, LogicalQueueKey: binding,
		PhysicalDeviceKey: physicalDeviceKey, IdentityStrength: identityStrength, OutputMedium: outputMedium}
	if err := proof.Validate(cfg, time.Now()); err != nil {
		return nil, err
	}
	return proof, nil
}

func (proof *OperationalVerification) Validate(cfg config.PrinterConfig, now time.Time) error {
	if proof == nil || proof.Version != 1 || !validGeometryPrinterID(proof.PrinterID) || proof.PrinterID != cfg.ID {
		return fmt.Errorf("%w: missing or mismatched printer proof", ErrPrinterUnverified)
	}
	method, strength, medium := operationalMethod(cfg)
	if method == "" || proof.Method != method || proof.IdentityStrength != strength || proof.OutputMedium != medium {
		return fmt.Errorf("%w: proof does not match the transport and output medium", ErrPrinterUnverified)
	}
	binding, err := config.PrinterBindingDigest(cfg)
	if err != nil || !geometryFingerprintPattern.MatchString(proof.BindingDigest) || proof.BindingDigest != binding || proof.LogicalQueueKey != binding {
		return fmt.Errorf("%w: proof belongs to a different execution destination", ErrPrinterUnverified)
	}
	if proof.PhysicalDeviceKey != "" && (!geometryFingerprintPattern.MatchString(proof.PhysicalDeviceKey) || method == "ipp_attributes" || method == "windows_queue" || medium == "file") {
		return fmt.Errorf("%w: invalid physical-device evidence", ErrPrinterUnverified)
	}
	verifiedAt, err := time.Parse(time.RFC3339Nano, proof.VerifiedAt)
	if err != nil || !geometryTimestampPattern.MatchString(proof.VerifiedAt) || now.Sub(verifiedAt) > 300*time.Second || verifiedAt.Sub(now) > 60*time.Second {
		return fmt.Errorf("%w: stale or invalid observation time", ErrPrinterUnverified)
	}
	return nil
}

func ProbeOperationalVerification(ctx context.Context, backend Printer, cfg config.PrinterConfig) (*OperationalVerification, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cfg.Capabilities["identity_collision"] != nil || cfg.Capabilities["inventory_present"] == false {
		return nil, fmt.Errorf("%w: printer identity requires explicit reconciliation", ErrPrinterUnverified)
	}
	if _, err := config.PrinterBindingDigest(cfg); err != nil {
		return nil, fmt.Errorf("%w: invalid configured destination", ErrPrinterUnverified)
	}
	verifier, ok := backend.(OperationalVerifier)
	if !ok {
		return nil, fmt.Errorf("%w: this backend cannot establish current printer existence", ErrPrinterUnverified)
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	proof, err := verifier.VerifyOperational(probeCtx, cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPrinterUnverified, err)
	}
	if err := probeCtx.Err(); err != nil {
		return nil, err
	}
	if err := proof.Validate(cfg, time.Now()); err != nil {
		return nil, err
	}
	return proof, nil
}

func operationalIdentityDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

// Backends cannot accidentally verify a replacement configuration using their
// previously opened destination. The Agent also fences the backend generation.
func verificationEndpointMatches(cfg config.PrinterConfig, endpoint, spoolerName string) bool {
	bound, err := config.PrinterBindingDigest(cfg)
	if err != nil {
		return false
	}
	actual := cfg
	actual.Endpoint, actual.SpoolerName = endpoint, spoolerName
	actualBinding, err := config.PrinterBindingDigest(actual)
	return err == nil && bound == actualBinding
}
