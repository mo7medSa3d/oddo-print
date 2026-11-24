package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/license"
)

const pairingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const pairingCodeLength = 6

// AgentVersion is reported during pairing and may be overridden at build time via -ldflags.
var AgentVersion = "1.0.0"

func normalizeAndValidatePairingCode(raw string) (string, error) {
	code := strings.ToUpper(strings.TrimSpace(raw))
	if len(code) != pairingCodeLength {
		return "", fmt.Errorf("pairing code must be exactly %d characters", pairingCodeLength)
	}
	for _, r := range code {
		if !strings.ContainsRune(pairingCodeAlphabet, r) {
			return "", fmt.Errorf("pairing code contains an invalid character; use the 6-character code shown in the dashboard")
		}
	}
	return code, nil
}

// Register pairs this machine with the Gateway and persists the credentials
// next to the existing config file. The secret is sealed in the secure store
// and is not persisted in plaintext config.yaml or echoed to stdout.
func Register(serverURL, pairingCode, configPath string) error {
	if err := config.ValidateServerURL(serverURL); err != nil {
		return err
	}
	origin, err := config.OdooOrigin(serverURL)
	if err != nil {
		return err
	}
	serverURL = origin
	endpoint, err := config.OdooEndpoint(serverURL, "/api/agent/register")
	if err != nil {
		return err
	}
	code, err := normalizeAndValidatePairingCode(pairingCode)
	if err != nil {
		return err
	}

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown-host"
	}

	payload := map[string]interface{}{
		"pairingCode":  code,
		"agentVersion": AgentVersion,
		"metadata": map[string]string{
			"hostname": hostname,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
		},
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("load config before registration: %w", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode registration request: %w", err)
	}

	client := &http.Client{
		Transport: odooDirectTransport,
		Timeout:   15 * time.Second,
		// Never follow redirects on the registration path: a 3xx target
		// must not receive the pairing code (mirrors the IPP client and
		// the desktop Rust client, which both disable redirects).
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create registration request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "yaseir-agent-cli/1")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("registration request failed: %w", err)
	}
	defer drainAndCloseBody(resp.Body)

	if resp.StatusCode != http.StatusOK {
		respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 8192))
		if readErr != nil {
			return fmt.Errorf("registration failed (%d); failed to read error body: %w", resp.StatusCode, readErr)
		}
		return fmt.Errorf("registration failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var data struct {
		AgentID       string          `json:"agentId"`
		Secret        string          `json:"secret"`
		LicenseBundle json.RawMessage `json:"licenseBundle"`
		OdooDBUUID    string          `json:"odooDbUuid"`
	}
	// Pairing persists a long-lived Agent credential. The response must be
	// one COMPLETE JSON object, not merely a parseable prefix; Decoder.Decode
	// otherwise accepts a valid object followed by corrupted/proxy-injected
	// content. Use a sentinel byte to distinguish a real EOF from a truncated
	// response at the 1 MiB limit BEFORE saving the new secret.
	const maxRegistrationResponseBytes = 1 << 20
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxRegistrationResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read registration response: %w", err)
	}
	if len(responseBody) > maxRegistrationResponseBytes {
		return fmt.Errorf("registration response exceeds %d-byte limit", maxRegistrationResponseBytes)
	}
	if err := json.Unmarshal(responseBody, &data); err != nil {
		return fmt.Errorf("decode complete registration response: %w", err)
	}
	if data.AgentID == "" || data.Secret == "" {
		return fmt.Errorf("registration response did not contain agentId/secret")
	}

	cfg.Server.URL = serverURL
	cfg.Agent.ID = data.AgentID
	cfg.Agent.Secret = data.Secret
	if cfg.Agent.Name == "" {
		cfg.Agent.Name = hostname
	}

	if err := cfg.Save(configPath); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}

	trimmedBundle := bytes.TrimSpace(data.LicenseBundle)
	if len(trimmedBundle) > 0 && string(trimmedBundle) != "null" {
		dataDir := filepath.Dir(config.QueueDBPath(configPath))
		if guard, gErr := license.NewRuntimeGuardFromConfig(dataDir); gErr == nil && guard != nil && guard.Enforcing() {
			if _, _, licErr := guard.ApplyBundle(trimmedBundle, strings.TrimSpace(data.OdooDBUUID), time.Now().UTC()); licErr != nil {
				fmt.Printf("WARNING: License bundle from registration rejected: %v\n", licErr)
			}
		}
	}

	fmt.Printf("Success! Agent registered as %s\n", data.AgentID)
	fmt.Println("Restart the agent (or start it from Yaseir Print Manager) to begin receiving jobs.")
	return nil
}
