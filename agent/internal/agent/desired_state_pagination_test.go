package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHeartbeatCollectsAllDesiredPagesBeforeAbsenceReconciliation(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.cfg.Agent.ID = "agt_test1234"
	a.cfg.Agent.Secret = "secret"
	first := testDesiredPrinter("a", 1, "active")
	second := testDesiredPrinter("b", 1, "active")
	a.reconcileGatewayDesiredState([]desiredPrinterWire{second})
	cursor := base64.RawURLEncoding.EncodeToString([]byte(first.ID))
	var continued atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/agent/heartbeat" {
			var request map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["desiredStatePaging"] != true {
				t.Error("Agent did not negotiate bounded desired-state pages")
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "desiredState": []desiredPrinterWire{first}, "desiredStateNextCursor": cursor})
			return
		}
		if r.URL.Path != "/api/agent/desired-state" || r.URL.Query().Get("after") != cursor {
			http.NotFound(w, r)
			return
		}
		continued.Store(true)
		a.printersMu.RLock()
		_, deletedEarly := a.gatewayTombstones[second.ID]
		a.printersMu.RUnlock()
		if deletedEarly {
			t.Error("a partial desired-state page deleted a printer before continuation")
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": a.cfg.Agent.ID, "desiredState": []desiredPrinterWire{second}})
	}))
	defer server.Close()
	a.cfg.Server.URL = server.URL
	a.client = server.Client()
	a.sendHeartbeatContext(context.Background())
	if !continued.Load() || !a.desiredStateSynced || len(a.desiredStates) != 2 {
		t.Fatalf("full desired-state synchronization failed: continued=%t synced=%t records=%d", continued.Load(), a.desiredStateSynced, len(a.desiredStates))
	}
}

func TestHeartbeatInvalidDesiredContinuationRetainsPriorStateAndFencesExecution(t *testing.T) {
	for _, failure := range []string{"http", "json", "identity", "missing", "loop", "oversize", "success", "invalid-row", "duplicate"} {
		t.Run(failure, func(t *testing.T) {
			a := newDesiredStateTestAgent(t)
			a.cfg.Agent.ID = "agt_test1234"
			a.cfg.Agent.Secret = "secret"
			prior := testDesiredPrinter("prior", 1, "active")
			a.reconcileGatewayDesiredState([]desiredPrinterWire{prior})
			a.desiredStateSynced = true
			first := testDesiredPrinter("a", 1, "active")
			cursor := base64.RawURLEncoding.EncodeToString([]byte(first.ID))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/agent/heartbeat" {
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": failure != "success", "desiredState": []desiredPrinterWire{first}, "desiredStateNextCursor": cursor})
					return
				}
				switch failure {
				case "http":
					w.WriteHeader(http.StatusServiceUnavailable)
				case "json":
					_, _ = w.Write([]byte(`{"success":true,"desiredState":[`))
				case "identity":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": "other", "desiredState": []desiredPrinterWire{}})
				case "missing":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": a.cfg.Agent.ID})
				case "loop":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": a.cfg.Agent.ID, "desiredState": []desiredPrinterWire{first}, "desiredStateNextCursor": cursor})
				case "oversize":
					_, _ = w.Write([]byte(strings.Repeat("x", maxDesiredStatePageBytes+1)))
				case "invalid-row":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": a.cfg.Agent.ID, "desiredState": []desiredPrinterWire{{}}})
				case "duplicate":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "agentId": a.cfg.Agent.ID, "desiredState": []desiredPrinterWire{first}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			a.cfg.Server.URL = server.URL
			a.client = server.Client()
			a.sendHeartbeatContext(context.Background())
			if a.desiredStateSynced || len(a.desiredStates) != 1 || a.desiredStates[prior.ID].Desired.ID != prior.ID {
				t.Fatalf("incomplete snapshot mutated prior state or removed its fence: synced=%t state=%v", a.desiredStateSynced, a.desiredStates)
			}
		})
	}
}

func TestHeartbeatDesiredStatePersistenceFailureKeepsExecutionFenced(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	a.cfg.Agent.ID = "agt_test1234"
	a.cfg.Agent.Secret = "secret"
	if err := os.WriteFile(a.configPath, []byte("config"), 0600); err != nil {
		t.Fatal(err)
	}
	a.desiredStatePath = filepath.Join(a.configPath, "blocked.json")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "desiredState": []desiredPrinterWire{testDesiredPrinter("a", 1, "active")}})
	}))
	defer server.Close()
	a.cfg.Server.URL = server.URL
	a.client = server.Client()
	a.sendHeartbeatContext(context.Background())
	if a.desiredStateSynced {
		t.Fatal("unpersisted desired-state snapshot enabled manager-owned execution")
	}
}

func TestDesiredStateSnapshotBudgetAndCursorValidation(t *testing.T) {
	a := newDesiredStateTestAgent(t)
	row := testDesiredPrinter("a", 1, "active")
	row.Config["oversize"] = strings.Repeat("x", maxDesiredStateSnapshotBytes)
	if _, err := a.collectGatewayDesiredState(context.Background(), []desiredPrinterWire{row}, ""); err == nil {
		t.Fatal("oversized full snapshot was accepted")
	}
	for _, cursor := range []string{"!", "YQ==", "Yg", "_w"} {
		if desiredStateCursorMatchesRows([]desiredPrinterWire{row}, cursor) {
			t.Errorf("invalid or nonmatching cursor %q was accepted", cursor)
		}
	}
}
