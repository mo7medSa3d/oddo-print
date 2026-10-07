package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yaseir-agent/agent/internal/config"
)

func TestWSRetryAfterLostSessionAndRejectedHandshakeIsPacedAndCancellable(t *testing.T) {
	for _, accept := range []bool{true, false} {
		name := "rejected_handshake"
		if accept {
			name = "accepted_then_closed"
		}
		t.Run(name, func(t *testing.T) {
			attempts := make(chan struct{}, 4)
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/agent/ws" || r.Header.Get("Authorization") != "Bearer agent:test-secret" {
					t.Errorf("incorrect WS request path or authentication")
				}
				select {
				case attempts <- struct{}{}:
				default:
				}
				if !accept {
					http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
					return
				}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Errorf("upgrade: %v", err)
					return
				}
				_ = conn.Close()
			}))
			defer server.Close()
			cfg := &config.Config{}
			cfg.Server.URL = "  " + server.URL + "/  "
			cfg.Agent.ID, cfg.Agent.Secret = "agent", "test-secret"
			ag := &Agent{cfg: cfg}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				ag.connectWebSocket(ctx)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
					ag.runtimeWG.Wait()
				case <-time.After(5 * time.Second):
					t.Error("WS reconnect did not exit on cancellation")
				}
			})
			select {
			case <-attempts:
			case <-time.After(5 * time.Second):
				t.Fatal("initial connection attempt did not reach the real server")
			}
			// Every retry has a production minimum of 2.5 seconds. An accepted
			// then closed session previously bypassed this wait entirely.
			select {
			case <-attempts:
				t.Fatal("connection failure bypassed the reconnect delay")
			case <-time.After(time.Second):
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("cancellation waited for the retry timer")
			}
			if ag.getWSConn() != nil {
				t.Fatal("lost session left a live connection reference")
			}
		})
	}
}

func TestWSShortSessionsShareBoundedBackoffAndStableSessionResets(t *testing.T) {
	var retry wsReconnectBackoff
	for _, step := range []time.Duration{5, 10, 20, 40, 60, 60} {
		step *= time.Second
		delay := retry.nextDelay(time.Second)
		if delay < step/2 || delay > step {
			t.Fatalf("short-session retry delay %s outside jittered step %s", delay, step)
		}
	}
	delay := retry.nextDelay(wsReconnectStableSession)
	if delay < wsReconnectInitialDelay/2 || delay > wsReconnectInitialDelay {
		t.Fatalf("stable session did not reset the retry budget: %s", delay)
	}
	// A failed handshake after recovery consumes the same budget as a flap.
	delay = retry.nextDelay(0)
	if delay < wsReconnectInitialDelay || delay > 2*wsReconnectInitialDelay {
		t.Fatalf("failed dial did not share the session retry budget: %s", delay)
	}
}
