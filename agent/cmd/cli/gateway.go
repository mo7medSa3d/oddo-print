package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

const gatewayRequestMaxBody = 8 * 1024 * 1024
const gatewayPaginationHeaderMaxBytes = 4096

// gatewayRequestBody completes the selected input before creating an HTTP
// request. The stdin path avoids Windows argv limits without accepting a
// silently truncated body or choosing between conflicting input sources.
func gatewayRequestBody(body string, bodySupplied, fromStdin bool, stdin io.Reader) (string, error) {
	if fromStdin && bodySupplied {
		return "", fmt.Errorf("gateway request -body and -body-stdin are mutually exclusive")
	}
	if fromStdin {
		if stdin == nil {
			return "", fmt.Errorf("gateway request stdin is unavailable")
		}
		data, err := io.ReadAll(io.LimitReader(stdin, gatewayRequestMaxBody+1))
		if err != nil {
			return "", fmt.Errorf("read Gateway request stdin failed: %w", err)
		}
		if len(data) > gatewayRequestMaxBody {
			return "", fmt.Errorf("gateway request body exceeds 8 MiB")
		}
		body = string(data)
	}
	if len(body) > gatewayRequestMaxBody {
		return "", fmt.Errorf("gateway request body exceeds 8 MiB")
	}
	return body, nil
}

func gatewayPaginationHeaders(headers http.Header) (map[string]string, error) {
	var pagination map[string]string
	for _, key := range []string{"x-has-more", "x-next-before-created-at", "x-next-before-id-encoded", "x-next-before-id", "x-next-cursor"} {
		if value := headers.Get(key); value != "" {
			if len(value) > gatewayPaginationHeaderMaxBytes {
				return nil, fmt.Errorf("Gateway pagination header %s exceeds 4096 bytes", key)
			}
			if pagination == nil {
				pagination = make(map[string]string)
			}
			pagination[key] = value
		}
	}
	return pagination, nil
}

// encodeGatewayResponse is the shared producer for the desktop envelope.
// json.Marshal escapes HTML/control bytes, so its stdout can be larger than
// the HTTP body while both body and optional fleet metadata stay bounded.
func encodeGatewayResponse(status uint16, data []byte, headers http.Header) ([]byte, error) {
	if len(data) > gatewayRequestMaxBody {
		return nil, fmt.Errorf("Gateway response exceeds 8 MiB")
	}
	paginationHeaders, err := gatewayPaginationHeaders(headers)
	if err != nil {
		return nil, err
	}
	response := struct {
		Status  uint16            `json:"status"`
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers,omitempty"`
	}{
		Status:  status,
		Body:    string(data),
		Headers: paginationHeaders,
	}
	return json.Marshal(response)
}

var gatewayPrinterActionPathRe = regexp.MustCompile("^/api/printers/[A-Za-z0-9._~-]+/test-connection$")
var gatewayTestPrintPathRe = regexp.MustCompile("^/api/printers/[A-Za-z0-9._~-]+/test-print$")
var gatewayTestKeyRe = regexp.MustCompile("^[A-Za-z0-9._:-]+$")
var gatewayCapturePreviewPathRe = regexp.MustCompile("^/api/agent/test-captures/preview[?]id=cap_[a-f0-9]{32}$")

// Deliberately wider than the desktop console proxy (which allows exact
// GET /api/agents only): the operator CLI needs single-agent fetch for
// diagnostics. Both surfaces are read-only.
var gatewayAgentPathRe = regexp.MustCompile("^/api/agents(?:/[A-Za-z0-9._~-]+)?$")

func normalizeOriginForCompare(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Hostname() == "" {
		return strings.ToLower(trimmed)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Fragment, parsed.RawQuery = "", ""
	return strings.TrimRight(parsed.String(), "/")
}

func handleGatewayRequest(args []string, configPath string) {
	fs := flag.NewFlagSet("gateway-request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	path := fs.String("path", "", "API-relative Gateway path")
	method := fs.String("method", "GET", "HTTP method")
	body := fs.String("body", "", "Optional JSON request body")
	bodyStdin := fs.Bool("body-stdin", false, "Read optional JSON request body from stdin")
	idempotencyKey := fs.String("idempotency-key", "", "Required Agent diagnostic retry key for test-print")
	expectOrigin := fs.String("expect-origin", "", "Expected desktop Gateway origin, verified against the paired Agent")
	configOverride := fs.String("config", configPath, "Path to the paired agent config file")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	reqPath := strings.TrimSpace(*path)
	reqMethod := strings.ToUpper(strings.TrimSpace(*method))
	if !isAllowedGatewayConsolePath(reqPath, reqMethod) {
		fmt.Fprintln(os.Stderr, "gateway request path/method is not permitted")
		os.Exit(2)
	}
	bodySupplied := false
	fs.Visit(func(option *flag.Flag) {
		if option.Name == "body" {
			bodySupplied = true
		}
	})
	requestBody, err := gatewayRequestBody(*body, bodySupplied, *bodyStdin, os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if gatewayTestPrintPathRe.MatchString(reqPath) {
		if len(*idempotencyKey) < 8 || len(*idempotencyKey) > 128 || !gatewayTestKeyRe.MatchString(*idempotencyKey) {
			fmt.Fprintln(os.Stderr, "Agent test-print requires a valid idempotency key")
			os.Exit(2)
		}
	} else if *idempotencyKey != "" {
		fmt.Fprintln(os.Stderr, "idempotency key is only accepted for printer test-print")
		os.Exit(2)
	}

	cfg, err := config.Load(*configOverride)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load agent config failed: %v\n", err)
		os.Exit(1)
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "agent config is not ready: %v\n", err)
		os.Exit(1)
	}
	if strings.TrimSpace(cfg.Server.URL) == "" || strings.TrimSpace(cfg.Agent.ID) == "" || strings.TrimSpace(cfg.Agent.Secret) == "" {
		fmt.Fprintln(os.Stderr, "agent is not paired with a Gateway")
		os.Exit(1)
	}

	// The desktop Gateway origin and paired Agent origin are separate inputs
	// identities: the caller must name the origin it intends to act on, and
	// the paired config must agree. Otherwise a desktop origin change could
	// show or mutate the old Agent Gateway under the new displayed origin.
	if expected := normalizeOriginForCompare(*expectOrigin); expected != "" {
		if normalizeOriginForCompare(strings.TrimSpace(cfg.Server.URL)) != expected {
			fmt.Fprintln(os.Stderr, "paired Agent Gateway origin differs from the requested desktop origin; re-pair or correct the Gateway URL")
			os.Exit(2)
		}
	}
	target, err := config.GatewayEndpoint(cfg.Server.URL, reqPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gateway request must stay on the configured Gateway origin")
		os.Exit(2)
	}

	var reader io.Reader
	if requestBody != "" {
		reader = bytes.NewBufferString(requestBody)
	}
	req, err := http.NewRequest(reqMethod, target, reader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create Gateway request failed: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Agent.ID+":"+cfg.Agent.Secret)
	req.Header.Set("User-Agent", "yaseir-agent-console/1")
	if *idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", *idempotencyKey)
	}
	if requestBody != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{
		Transport: &http.Transport{
			Proxy: func(req *http.Request) (*url.URL, error) {
				if os.Getenv("YASEIR_AGENT_ALLOW_PROXY") == "1" {
					return http.ProxyFromEnvironment(req)
				}
				return nil, nil
			},
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 20 * time.Second}).DialContext,
			TLSHandshakeTimeout: 5 * time.Second,
		},
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Gateway request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, gatewayRequestMaxBody+1))
	if err != nil {
		fmt.Fprintf(os.Stderr, "read Gateway response failed: %v\n", err)
		os.Exit(1)
	}
	if len(data) > gatewayRequestMaxBody {
		fmt.Fprintln(os.Stderr, "Gateway response exceeds 8 MiB")
		os.Exit(1)
	}
	// Return the real HTTP status and body for every application response.
	// The Tauri desktop bridge uses this envelope to preserve 4xx/5xx semantics;
	// only transport/configuration failures use a non-zero process exit.
	encoded, err := encodeGatewayResponse(uint16(resp.StatusCode), data, resp.Header)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode Gateway response failed: %v\n", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(encoded); err != nil {
		fmt.Fprintf(os.Stderr, "write Gateway response failed: %v\n", err)
		os.Exit(1)
	}
	if _, err := fmt.Fprintln(os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "write Gateway response newline failed: %v\n", err)
		os.Exit(1)
	}
}

func isAllowedJobsPath(path string) bool {
	parsed, err := url.Parse(path)
	if err != nil || parsed.Path != "/api/jobs" || parsed.RawPath != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.RawQuery == "" {
		return true
	}
	for _, pair := range strings.Split(parsed.RawQuery, "&") {
		if pair == "" || !strings.Contains(pair, "=") {
			return false
		}
	}
	for key, values := range parsed.Query() {
		if len(values) != 1 || len(values[0]) > 200 {
			return false
		}
		switch key {
		case "limit", "offset", "status", "search", "q", "printerId", "agentId":
		default:
			return false
		}
	}
	return true
}

func isAllowedGatewayConsolePath(path, method string) bool {
	// Match the Rust WebView boundary: neither direct CLI callers nor decoded
	// URLs may smuggle dot segments into authenticated Agent operations.
	if strings.Contains(path, "..") || strings.Contains(path, "\\") {
		return false
	}
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "GET":
		return isAllowedFleetPath(path) ||
			isAllowedJobsPath(path) ||
			gatewayAgentPathRe.MatchString(path) ||
			path == "/api/agent/test-captures/status" ||
			gatewayCapturePreviewPathRe.MatchString(path)
	case "POST":
		return path == "/api/printers" || gatewayPrinterActionPathRe.MatchString(path) || gatewayTestPrintPathRe.MatchString(path)
	case "DELETE":
		// Explicit scoped deletion of terminal simulation evidence only.
		return path == "/api/agent/test-captures/status"
	// Agent diagnostic print is scoped to its own printer at Gateway; it is
	// not authorized to mutate desired state or cross-Agent printer records.
	default:
		return false
	}
}

func isAllowedFleetPath(path string) bool {
	parsed, err := url.Parse(path)
	if err != nil || (parsed.Path != "/api/printers" && parsed.Path != "/api/agents") || parsed.RawPath != "" || parsed.Fragment != "" || parsed.IsAbs() || parsed.Host != "" {
		return false
	}
	if parsed.RawQuery == "" {
		return true
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || len(query) == 0 {
		return false
	}
	for _, pair := range strings.Split(parsed.RawQuery, "&") {
		if pair == "" || !strings.Contains(pair, "=") {
			return false
		}
	}
	for key, values := range query {
		if len(values) != 1 || values[0] == "" || len(values[0]) > 4096 {
			return false
		}
		switch key {
		case "limit", "offset", "beforeCreatedAt", "beforeId", "beforeIdEncoded":
		default:
			return false
		}
	}
	return true
}
