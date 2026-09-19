package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/yasser-agent/agent/internal/config"
)

const gatewayRequestMaxBody = 8 * 1024 * 1024

var gatewayPrinterPathRe = regexp.MustCompile("^/api/printers(?:/[A-Za-z0-9._~-]+(?:/(?:test-connection|test-print))?)?$")
var gatewayPrinterActionPathRe = regexp.MustCompile("^/api/printers/[A-Za-z0-9._~-]+/(?:test-connection|test-print)$")
var gatewayAgentPathRe = regexp.MustCompile("^/api/agents(?:/[A-Za-z0-9._~-]+)?$")

func handleGatewayRequest(args []string, configPath string) {
	fs := flag.NewFlagSet("gateway-request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	path := fs.String("path", "", "API-relative Gateway path")
	method := fs.String("method", "GET", "HTTP method")
	body := fs.String("body", "", "Optional JSON request body")
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
	if len(*body) > gatewayRequestMaxBody {
		fmt.Fprintln(os.Stderr, "gateway request body exceeds 8 MiB")
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

	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.Server.URL), "/"))
	if err != nil || base.Hostname() == "" {
		fmt.Fprintln(os.Stderr, "configured Gateway URL is invalid")
		os.Exit(1)
	}
	target, err := base.Parse(reqPath)
	if err != nil || target.Scheme != base.Scheme || target.Host != base.Host {
		fmt.Fprintln(os.Stderr, "gateway request must stay on the configured Gateway origin")
		os.Exit(2)
	}

	var reader io.Reader
	if *body != "" {
		reader = bytes.NewBufferString(*body)
	}
	req, err := http.NewRequest(reqMethod, target.String(), reader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create Gateway request failed: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Agent.ID+":"+cfg.Agent.Secret)
	req.Header.Set("User-Agent", "yasser-agent-console/1")
	if *body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{
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
	response := struct {
		Status uint16 `json:"status"`
		Body   string `json:"body"`
	}{
		Status: uint16(resp.StatusCode),
		Body:   string(data),
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode Gateway response failed: %v\n", err)
		os.Exit(1)
	}
	_, _ = os.Stdout.Write(encoded)
	fmt.Fprintln(os.Stdout)

func isAllowedJobsPath(path string) bool {
	parsed, err := url.Parse(path)
	if err != nil || parsed.Path != "/api/jobs" || parsed.RawPath != "" || parsed.Fragment != "" {
		return false
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
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "GET":
		return path == "/api/printers" ||
			isAllowedJobsPath(path) ||
			gatewayAgentPathRe.MatchString(path)
	case "POST":
		return path == "/api/printers" || gatewayPrinterActionPathRe.MatchString(path)
	case "PATCH":
		return gatewayPrinterPathRe.MatchString(path) && path != "/api/printers"
	default:
		return false
	}
}
