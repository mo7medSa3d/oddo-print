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

func filterDevicesByEndpoint(devices []printer.DeviceInfo, endpoint string) []printer.DeviceInfo {
	var matched []printer.DeviceInfo
	for _, d := range devices {
		if d.Endpoint == endpoint {
			matched = append(matched, d)
		}
	}
	return matched
}

func filterDevicesByUSBVID(devices []printer.DeviceInfo, vid string) []printer.DeviceInfo {
	var matched []printer.DeviceInfo
	for _, d := range devices {
		if d.USBVID == vid {
			matched = append(matched, d)
		}
	}
	return matched
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
	matched := filterDevicesByUSBVID(rows, "1234")
	if err != nil || len(matched) != 2 {
		t.Fatalf("new endpoint replaced an established hardware-derived ID: %+v, %v", matched, err)
	}
}

func TestRegisterManualUsesPersistedCanonicalIdentityForRuntime(t *testing.T) {
	a := newRegistryDisablementAgent(t, &config.Config{}, nil)
	incoming := productionNetworkDevice("", "10.0.0.20:9100")
	if err := a.RegisterManual(incoming); err != nil {
		t.Fatal(err)
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	matched := filterDevicesByEndpoint(rows, "10.0.0.20:9100")
	if err != nil || len(matched) != 1 {
		t.Fatalf("manual registration missing: %+v, %v", matched, err)
	}
	if _, exists := a.getPrinter(matched[0].ID); !exists {
		t.Fatalf("runtime identity differs from persisted registration %q", matched[0].ID)
	}
}

func TestRegisterManualAliasCannotEnableAnEstablishedDisabledBinding(t *testing.T) {
	prior := productionNetworkDevice("retained-id", "10.0.0.20:9100")
	prior.Enabled = false
	a := newRegistryDisablementAgent(t, &config.Config{}, []printer.DeviceInfo{prior})
	beforeCount := a.printerCount()
	incoming := prior
	incoming.ID, incoming.Enabled = "", true
	if err := a.RegisterManual(incoming); err != nil {
		t.Fatal(err)
	}
	if _, exists := a.getPrinter(prior.ID); exists || a.printerCount() != beforeCount {
		t.Fatal("an auto-ID alias created an enabled backend for a disabled registration")
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	matched := filterDevicesByEndpoint(rows, "10.0.0.20:9100")
	if err != nil || len(matched) != 1 || matched[0].ID != prior.ID || matched[0].Enabled {
		t.Fatalf("alias changed established identity or local disablement: %+v, %v", matched, err)
	}
}

func TestRegisterManualCannotChooseBetweenAmbiguousPersistedBindings(t *testing.T) {
	first := productionNetworkDevice("first-id", "10.0.0.20:9100")
	first.Enabled = false
	second := first
	second.ID = "second-id"
	a := newRegistryDisablementAgent(t, &config.Config{}, []printer.DeviceInfo{first, second})
	beforeCount := a.printerCount()
	incoming := first
	incoming.ID, incoming.Enabled = "", true
	if err := a.RegisterManual(incoming); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous registrations must require explicit resolution: %v", err)
	}
	_, hasFirst := a.getPrinter(first.ID)
	_, hasSecond := a.getPrinter(second.ID)
	if hasFirst || hasSecond || a.printerCount() != beforeCount {
		t.Fatal("ambiguous binding created an executable backend")
	}
	rows, err := printer.LoadRegistryPrinters(a.registryPath)
	matched := filterDevicesByEndpoint(rows, "10.0.0.20:9100")
	if err != nil || len(matched) != 2 {
		t.Fatalf("existing ambiguity was deleted or assigned a third ID: %+v, %v", matched, err)
	}
}
