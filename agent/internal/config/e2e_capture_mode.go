package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

// ReadE2ECaptureMode reads only the explicit local opt-in flag. The protected
// config and secret never leave the privileged Agent/Manager boundary.
func ReadE2ECaptureMode(path string) (bool, error) {
	if path == "" {
		return false, fmt.Errorf("agent config path is empty")
	}
	if _, err := os.Stat(path); err != nil {
		return false, fmt.Errorf("agent config is unavailable: %w", err)
	}
	cfg, err := Load(path)
	if err != nil {
		return false, fmt.Errorf("read protected agent config: %w", err)
	}
	return cfg.Server.E2ECaptureTests, nil
}

// SetE2ECaptureMode is an explicit Administrator-only operator action. Patch
// just the YAML scalar so unknown settings, comments, pairing IDs and the
// externally sealed Agent secret are not rewritten or lost.
func SetE2ECaptureMode(path string, enabled bool) error {
	if path == "" {
		return fmt.Errorf("agent config path is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(absolute); err != nil {
		return fmt.Errorf("agent config must exist before changing capture mode: %w", err)
	}

	// Load enforces and repairs the machine trust boundary and performs any
	// one-time plaintext secret migration before touching the YAML.
	cfg, err := Load(absolute)
	if err != nil {
		return fmt.Errorf("read protected agent config: %w", err)
	}
	if cfg.Server.URL == "" || cfg.Agent.ID == "" || cfg.Agent.Secret == "" {
		return fmt.Errorf("pair the Windows Agent with the Gateway first")
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("agent configuration is invalid: %w", err)
	}
	if cfg.Server.E2ECaptureTests == enabled {
		return nil
	}

	original, err := os.ReadFile(absolute)
	if err != nil {
		return err
	}
	if len(original) > 256*1024 {
		return fmt.Errorf("agent configuration exceeds safe update limit")
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(original, &doc); err != nil {
		return fmt.Errorf("parse agent configuration: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("agent configuration must be a YAML mapping")
	}
	root := doc.Content[0]
	var server *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "server" {
			continue
		}
		if server != nil {
			return fmt.Errorf("duplicate server configuration")
		}
		server = root.Content[i+1]
	}
	if server == nil {
		server = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "server"}, server)
	}
	if server.Kind != yaml.MappingNode {
		return fmt.Errorf("server configuration must be a YAML mapping")
	}
	var value *yaml.Node
	for i := 0; i+1 < len(server.Content); i += 2 {
		if server.Content[i].Value != "e2e_capture_tests" {
			continue
		}
		if value != nil {
			return fmt.Errorf("duplicate E2E capture setting")
		}
		value = server.Content[i+1]
	}
	if value == nil {
		value = &yaml.Node{}
		server.Content = append(server.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "e2e_capture_tests"}, value)
	}
	value.Kind, value.Tag, value.Value = yaml.ScalarNode, "!!bool", strconv.FormatBool(enabled)
	value.Style = 0
	updated, err := yaml.Marshal(&doc)
	if err != nil {
		return fmt.Errorf("encode agent configuration: %w", err)
	}

	// Detect an intervening change (for example a simultaneous pairing)
	// rather than quietly discarding it.
	latest, err := os.ReadFile(absolute)
	if err != nil {
		return err
	}
	if !bytes.Equal(original, latest) {
		return fmt.Errorf("agent config changed; retry the operation")
	}

	dir := filepath.Dir(absolute)
	temp, err := os.CreateTemp(dir, ".capture-config-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return err
	}
	if err := EnsureSecureFileACL(tempPath); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(updated); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := replaceFile(tempPath, absolute); err != nil {
		return fmt.Errorf("update E2E setting: %w", err)
	}
	return EnsureSecureFileACL(absolute)
}
