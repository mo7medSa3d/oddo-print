package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

func newRegistryDisablementAgent(t *testing.T, cfg *config.Config, devices []printer.DeviceInfo) *Agent {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := printer.SaveRegistry(config.RegistryPath(path), devices); err != nil {
		t.Fatal(err)
	}
	a, err := New(cfg, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	completeDisablementTestSync(t, a)
	return a
}

func completeDisablementTestSync(t *testing.T, a *Agent) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/agent/heartbeat" {
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": body["status"]})
	}))
	t.Cleanup(server.Close)
	a.cfg.Agent.ID, a.cfg.Agent.Secret, a.cfg.Server.URL = "agt_test", "secret", server.URL
}

func TestRegisterManualCannotRebindGeneratedHardwareID(t *testing.T) {
	prior := printer.DeviceInfo{Name: "First USB printer", PrinterType: "physical", ConnectionType: "usb", Protocol: "raw",
		Endpoint: `\\?\usb#vid_1234&pid_5678#device-a`, USBVID: "1234", USBPID: "5678", USBSerial: "same-serial", Enabled: false}
	prior.ID = printer.StableIDForDevice(prior)
	a := newRegistryDisablementAgent(t, &config.Config{}, []printer.DeviceInfo{prior})
	incoming := prior
	incoming.ID, incoming.Endpoint = "", `\\?\usb#vid_1234&pid_5678#device-b`
	if err := a.RegisterManual(incoming); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 2 {
		t.Fatalf("new endpoint replaced an established hardware-derived ID: %+v, %v", rows, err)
	}
}

func TestRegisterManualUsesPersistedCanonicalIdentityForRuntime(t *testing.T) {
	a := newRegistryDisablementAgent(t, &config.Config{}, nil)
	incoming := productionNetworkDevice("", "10.0.0.20:9100")
	if err := a.RegisterManual(incoming); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 1 {
		t.Fatalf("manual registration missing: %+v, %v", rows, err)
	}
	if _, exists := a.getPrinter(rows[0].ID); !exists {
		t.Fatalf("runtime identity differs from persisted registration %q", rows[0].ID)
	}
}

func TestRegisterManualAliasCannotEnableAnEstablishedDisabledBinding(t *testing.T) {
	prior := productionNetworkDevice("retained-id", "10.0.0.20:9100")
	prior.Enabled = false
	a := newRegistryDisablementAgent(t, &config.Config{}, []printer.DeviceInfo{prior})
	incoming := prior
	incoming.ID, incoming.Enabled = "", true
	if err := a.RegisterManual(incoming); err != nil {
		t.Fatal(err)
	}
	if a.printerCount() != 0 {
		t.Fatal("an auto-ID alias created an enabled backend for a disabled registration")
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 1 || rows[0].ID != prior.ID || rows[0].Enabled {
		t.Fatalf("alias changed established identity or local disablement: %+v, %v", rows, err)
	}
}

func TestRegisterManualCannotChooseBetweenAmbiguousPersistedBindings(t *testing.T) {
	first := productionNetworkDevice("first-id", "10.0.0.20:9100")
	first.Enabled = false
	second := first
	second.ID = "second-id"
	a := newRegistryDisablementAgent(t, &config.Config{}, []printer.DeviceInfo{first, second})
	incoming := first
	incoming.ID, incoming.Enabled = "", true
	if err := a.RegisterManual(incoming); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous registrations must require explicit resolution: %v", err)
	}
	if a.printerCount() != 0 {
		t.Fatal("ambiguous binding created an executable backend")
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	if err != nil || len(rows) != 2 {
		t.Fatalf("existing ambiguity was deleted or assigned a third ID: %+v, %v", rows, err)
	}
}
