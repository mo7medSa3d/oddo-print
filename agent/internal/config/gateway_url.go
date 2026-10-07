package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

func parseServerOrigin(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil {
		// Parsing errors can include the complete input, including credentials.
		return nil, fmt.Errorf("server.url invalid")
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("server.url host is empty")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return nil, fmt.Errorf("server.url must not contain credentials, query strings, or fragments")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("server.url scheme must be http or https")
	}
	if (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return nil, fmt.Errorf("server.url must use the origin root; Gateway base paths are not supported")
	}
	if strings.Contains(u.Hostname(), ":") && !strings.HasPrefix(u.Host, "[") {
		return nil, fmt.Errorf("server.url IPv6 addresses must be enclosed in brackets")
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, fmt.Errorf("server.url port is empty")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("server.url port must be between 1 and 65535")
		}
	}
	u.Path = ""
	return u, nil
}

// GatewayOrigin canonicalizes an already authorized HTTP(S) origin. Startup
// and pairing must still call ValidateServerURL to enforce the HTTP opt-in.
func GatewayOrigin(raw string) (string, error) {
	u, err := parseServerOrigin(raw)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// GatewayEndpoint resolves an API path without changing the configured origin
// or retaining a trailing root slash. Callers own any endpoint query values.
func GatewayEndpoint(raw, apiPath string) (string, error) {
	u, err := parseServerOrigin(raw)
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(apiPath)
	if err != nil || ref.IsAbs() || ref.Host != "" || ref.User != nil || ref.RawPath != "" ||
		ref.Fragment != "" || strings.Contains(apiPath, "#") || strings.Contains(ref.Path, "\\") ||
		strings.Contains(ref.Path, "//") || !strings.HasPrefix(ref.Path, "/api/") {
		return "", fmt.Errorf("Gateway endpoint must be an absolute API path on the configured origin")
	}
	for _, segment := range strings.Split(ref.Path, "/") {
		if segment == "." || segment == ".." {
			return "", fmt.Errorf("Gateway endpoint must not contain path traversal")
		}
	}
	return u.ResolveReference(ref).String(), nil
}

func GatewayWebSocketURL(raw string) (string, error) {
	endpoint, err := GatewayEndpoint(raw, "/api/agent/ws")
	if err != nil {
		return "", err
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("invalid Gateway WebSocket endpoint")
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	return u.String(), nil
}
