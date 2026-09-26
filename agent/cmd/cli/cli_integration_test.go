package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCLICommandsAgainstStubGateway(t *testing.T) {
	type seenRequest struct {
		Method string
		Path   string
		Auth   string
	}
	seen := make(chan seenRequest, 4)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- seenRequest{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization")}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/agent/register":
			_, _ = w.Write([]byte("{\"agentId\":\"agt_cli_test\",\"secret\":\"sec_cli_test\"}"))
		case r.Method == http.MethodGet && r.URL.Path == "/api/printers":
			_, _ = w.Write([]byte("{\"printers\":[]}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "config.yaml")
	binary := filepath.Join(tmp, "yasser-agent-cli")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}

	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = "."
	buildOut, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build real CLI binary: %v\n%s", err, buildOut)
	}

	env := append([]string{}, os.Environ()...)
	env = append(env, "YASSER_AGENT_ALLOW_INSECURE_HTTP=1")

	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(binary, args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("CLI %v failed: %v\n%s", args, err, out)
		}
		return string(out)
	}

	pairOut := run("-pair", "ABC234", "-server", server.URL, "-config", configPath)
	if !strings.Contains(pairOut, "Success! Agent registered as agt_cli_test") {
		t.Fatalf("pairing output did not prove success: %s", pairOut)
	}

	requestOut := run("gateway-request", "-method", "GET", "-path", "/api/printers", "-config", configPath)
	var envelope struct {
		Status uint16 `json:"status"`
		Body   string `json:"body"`
	}
	if err := json.Unmarshal([]byte(requestOut), &envelope); err != nil {
		t.Fatalf("decode gateway-request envelope: %v\n%s", err, requestOut)
	}
	if envelope.Status != http.StatusOK || envelope.Body != "{\"printers\":[]}" {
		t.Fatalf("unexpected gateway-request response: %+v", envelope)
	}

	cleanupOut := run("jobs", "cleanup", "--json", "--config", configPath)
	var cleanup struct {
		Deleted       int `json:"deleted"`
		UnknownPurged int `json:"unknownPurged"`
		UnknownKept   int `json:"unknownKept"`
	}
	if err := json.Unmarshal([]byte(cleanupOut), &cleanup); err != nil {
		t.Fatalf("decode cleanup result: %v\n%s", err, cleanupOut)
	}
	if cleanup.Deleted != 0 || cleanup.UnknownPurged != 0 || cleanup.UnknownKept != 0 {
		t.Fatalf("fresh queue cleanup should be empty: %+v", cleanup)
	}

	for i := 0; i < 2; i++ {
		select {
		case req := <-seen:
			if i == 0 && (req.Path != "/api/agent/register" || req.Method != http.MethodPost) {
				t.Fatalf("unexpected first stub Gateway request: %+v", req)
			}
			if i == 1 && (req.Path != "/api/printers" || req.Method != http.MethodGet) {
				t.Fatalf("unexpected second stub Gateway request: %+v", req)
			}
			if i == 1 && !strings.HasPrefix(req.Auth, "Bearer agt_cli_test:sec_cli_test") {
				t.Fatalf("gateway-request did not send the paired Agent bearer: %q", req.Auth)
			}
		default:
			t.Fatalf("expected stub Gateway to receive register + gateway-request, only saw %d request(s)", i)
		}
	}

	if _, err := os.Stat(filepath.Join(tmp, "agent-secrets.dat")); err != nil {
		t.Fatalf("pairing did not persist the secret store: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "queue.db")); err != nil {
		t.Fatalf("cleanup did not create the local queue database: %v", err)
	}
}
