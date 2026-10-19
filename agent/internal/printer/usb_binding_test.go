package printer

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestUSBPrintBindingRequiresNativeInterfaceAndNearestIdentity(t *testing.T) {
	const path = `\\?\usb#opaque-selected-interface`
	const childID = `USBPRINT\Receipt_Model\native-queue-instance`
	interfaces := []usbPrintInterface{{path: path, instanceID: childID, devInst: 1}}
	for _, tc := range []struct {
		name, path, serial, parentID string
		vid, pid                     uint16
		wantErr                      string
	}{
		{name: "hardware serial", path: path, vid: 0x1234, pid: 0x5678, serial: "hardware-serial", parentID: `USB\VID_1234&PID_5678\hardware-serial`},
		{name: "inventory instance serial", path: path, vid: 0x1234, pid: 0x5678, serial: "native-queue-instance", parentID: `USB\VID_1234&PID_5678\hardware-serial`},
		{name: "Windows casing", path: strings.ToUpper(path), vid: 0x1234, pid: 0x5678, serial: "HARDWARE-SERIAL", parentID: `usb\vid_1234&pid_5678&mi_00\hardware-serial`},
		{name: "zero product is a complete 16 bit ID", path: path, vid: 0x1234, pid: 0, parentID: `USB\VID_1234&PID_0000\hardware-serial`},
		{name: "unrelated path", path: `\\.\PhysicalDrive0`, vid: 0x1234, pid: 0x5678, parentID: `USB\VID_1234&PID_5678\hardware-serial`, wantErr: "not a currently present"},
		{name: "path prefix cannot substitute", path: path + "-other", vid: 0x1234, pid: 0x5678, parentID: `USB\VID_1234&PID_5678\hardware-serial`, wantErr: "not a currently present"},
		{name: "different product", path: path, vid: 0x1234, pid: 0x1111, parentID: `USB\VID_1234&PID_5678\hardware-serial`, wantErr: "identity mismatch"},
		{name: "different serial", path: path, vid: 0x1234, pid: 0x5678, serial: "other-printer", parentID: `USB\VID_1234&PID_5678\hardware-serial`, wantErr: "serial mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parentCalls := 0
			parent := func(node uint32) (uint32, error) {
				parentCalls++
				if node != 1 {
					t.Fatal("must not search past the nearest USB hardware identity")
				}
				return 2, nil
			}
			readID := func(node uint32) (string, error) {
				if node != 2 {
					t.Fatalf("unexpected device node: %d", node)
				}
				return tc.parentID, nil
			}
			err := validateUSBPrintBinding(context.Background(), tc.path, tc.vid, tc.pid, tc.serial, interfaces, parent, readID)
			if tc.wantErr == "" && err != nil || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("binding result=%v want error containing %q", err, tc.wantErr)
			}
			if strings.Contains(tc.wantErr, "not a currently present") && parentCalls != 0 {
				t.Fatal("unselected device ancestry was queried")
			}
		})
	}
}

func TestUSBHardwareIdentityDoesNotParseSymbolicPathsOrPartialIDs(t *testing.T) {
	for _, id := range []string{
		`\\?\usb#vid_1234&pid_5678#serial`, `USBPRINT\model\serial`,
		`USB\VID_123&PID_5678\serial`, `USB\VID_+123&PID_5678\serial`,
		`USB\VID_1234&PID_567g\serial`, `USB\VID_1234&PID_56789\serial`,
		`USB\other_VID_1234&PID_5678\serial`, `USB\VID_1234&PID_5678\`,
	} {
		if _, _, _, ok := usbHardwareIdentity(id); ok {
			t.Fatalf("accepted malformed or non-USB native identity %q", id)
		}
	}
}

func TestUSBPrintBindingRefusesAmbiguousCurrentPath(t *testing.T) {
	interfaces := []usbPrintInterface{
		{path: "same", instanceID: `USB\VID_1234&PID_5678\first`, devInst: 1},
		{path: "SAME", instanceID: `USB\VID_1234&PID_5678\second`, devInst: 2},
	}
	if err := validateUSBPrintBinding(context.Background(), "same", 0x1234, 0x5678, "", interfaces, nil, nil); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous interface accepted: %v", err)
	}
}

func TestUSBParentProofIsBoundedAndPropagatesNativeFailure(t *testing.T) {
	iface := usbPrintInterface{path: "opaque", instanceID: `USBPRINT\model\serial`, devInst: 1}
	for _, tc := range []string{"cycle", "depth", "parent failure", "identity failure", "cancelled"} {
		t.Run(tc, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc == "cancelled" {
				cancel()
			}
			calls := 0
			parent := func(node uint32) (uint32, error) {
				calls++
				if tc == "parent failure" {
					return 0, errors.New("device removed")
				}
				if tc == "cycle" {
					return node, nil
				}
				return node + 1, nil
			}
			readID := func(node uint32) (string, error) {
				if tc == "identity failure" {
					return "", errors.New("device removed")
				}
				return fmt.Sprintf(`USBPRINT\model\node-%d`, node), nil
			}
			if _, err := nearestUSBHardwareInstance(ctx, iface, parent, readID); err == nil {
				t.Fatal("unproven USB ancestry was accepted")
			}
			if calls > 16 || tc == "cancelled" && calls != 0 {
				t.Fatalf("unbounded/cancelled native parent queries: %d", calls)
			}
		})
	}
}

func TestUSBDiscoveryEnrichmentPreservesLegacyIdentityAndPrivateBinding(t *testing.T) {
	const path = `\\?\usb#opaque-native-interface`
	const childID = `USBPRINT\Receipt_Model\native-child-serial`
	id := StableIDFromUSBFull("0000", "0000", "native-child-serial", "USB001", childID)
	legacy := DeviceInfo{ID: id, Name: "Receipt printer", ConnectionType: "usb", Type: "usb", Protocol: "raw", Endpoint: path,
		USBVID: "0000", USBPID: "0000", USBSerial: "native-child-serial", Enabled: true,
		Capabilities: map[string]interface{}{"discovered_via": SourceUSB, "registration_source": "discovery", "device_instance_id": childID}}
	iface := usbPrintInterface{path: path, instanceID: childID, devInst: 1}
	parent := func(uint32) (uint32, error) { return 2, nil }
	readID := func(uint32) (string, error) { return `USB\VID_1234&PID_5678\hardware-serial`, nil }
	enriched, err := enrichUSBDiscoveryIdentity(context.Background(), legacy, iface, parent, readID)
	if err != nil {
		t.Fatal(err)
	}
	if enriched.ID != id || enriched.Endpoint != path || enriched.USBSerial != legacy.USBSerial || enriched.USBVID != "1234" || enriched.USBPID != "5678" {
		t.Fatalf("native metadata enrichment rebound the printer: %#v", enriched)
	}
	if err := validateUSBPrintBinding(context.Background(), path, 0x1234, 0x5678, enriched.USBSerial, []usbPrintInterface{iface}, parent, readID); err != nil {
		t.Fatalf("enriched discovery metadata cannot dispatch to the same native interface: %v", err)
	}
	before, err := config.PrinterBindingDigest(SharingConfigForDevice(legacy))
	if err != nil {
		t.Fatal(err)
	}
	after, err := config.PrinterBindingDigest(SharingConfigForDevice(enriched))
	if err != nil || before != after {
		t.Fatalf("metadata changed sharing destination: before=%s after=%s err=%v", before, after, err)
	}
	policy := config.PrinterSharing{Present: true, Version: 1, DeniedPrinters: map[string]string{id: before}}
	if shared, err := policy.Shared(SharingConfigForDevice(enriched), []config.PrinterConfig{SharingConfigForDevice(enriched)}); err != nil || shared {
		t.Fatalf("private printer became shared after enrichment: shared=%v err=%v", shared, err)
	}
	enriched.Capabilities = maps.Clone(enriched.Capabilities)
	enriched.Capabilities["usb_identity_verified"] = true
	registry := filepath.Join(t.TempDir(), "printers.json")
	if err := SaveRegistry(registry, []DeviceInfo{legacy}); err != nil {
		t.Fatal(err)
	}
	rows, err := UpsertRegistry(registry, []DeviceInfo{enriched})
	if err != nil || len(rows) != 1 || rows[0].ID != id || rows[0].USBVID != "1234" || rows[0].USBPID != "5678" || rows[0].Endpoint != path {
		t.Fatalf("legacy registry metadata was not refreshed coherently: rows=%#v err=%v", rows, err)
	}
}

func TestUSBDiscoveryCannotOverwriteAuthoritativeOrUnprovenIdentity(t *testing.T) {
	base := DeviceInfo{ID: "legacy-id", Name: "Receipt printer", ConnectionType: "usb", Protocol: "raw", Endpoint: `\\?\usb#selected`, USBVID: "0000", USBPID: "0000",
		Capabilities: map[string]interface{}{"discovered_via": SourceUSB, "registration_source": "discovery"}}
	incoming := base
	incoming.USBVID, incoming.USBPID = "1234", "5678"
	incoming.Capabilities = maps.Clone(base.Capabilities)
	incoming.Capabilities["usb_identity_verified"] = true
	for _, source := range []string{"manual", "config", "desired"} {
		t.Run(source, func(t *testing.T) {
			existing := base
			existing.Capabilities = maps.Clone(base.Capabilities)
			existing.Capabilities["registration_source"] = source
			merged := mergeDeviceInfo(existing, incoming)
			if merged.USBVID != base.USBVID || merged.USBPID != base.USBPID {
				t.Fatalf("native discovery overwrote %s authority: %#v", source, merged)
			}
		})
	}
	for _, failure := range []string{"unproved", "different path", "different ID", "different source", "malformed IDs"} {
		t.Run(failure, func(t *testing.T) {
			candidate := incoming
			candidate.Capabilities = maps.Clone(incoming.Capabilities)
			switch failure {
			case "unproved":
				candidate.Capabilities["usb_identity_verified"] = false
			case "different path":
				candidate.Endpoint += "-other"
			case "different ID":
				candidate.ID += "-other"
			case "different source":
				candidate.Capabilities["discovered_via"] = SourceSpooler
			case "malformed IDs":
				candidate.USBVID = "bad"
			}
			merged := mergeDeviceInfo(base, candidate)
			if merged.USBVID != base.USBVID || merged.USBPID != base.USBPID {
				t.Fatalf("unproven metadata overwrote observed binding: %#v", merged)
			}
		})
	}
}

func TestUSBDiscoveryExpiredSharedIdentityBudgetStartsNoMoreQueries(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 3; i++ {
		info := DeviceInfo{ID: fmt.Sprintf("legacy-%d", i), Endpoint: "opaque", USBVID: "0000", USBPID: "0000"}
		iface := usbPrintInterface{path: info.Endpoint, instanceID: `USBPRINT\model\child`, devInst: uint32(i + 1)}
		parent := func(uint32) (uint32, error) {
			t.Fatal("expired shared discovery budget started another parent query")
			return 0, nil
		}
		readID := func(uint32) (string, error) {
			t.Fatal("expired shared discovery budget started another identity query")
			return "", nil
		}
		result, err := enrichUSBDiscoveryIdentity(ctx, info, iface, parent, readID)
		if !errors.Is(err, context.Canceled) || result.ID != info.ID || result.USBVID != "0000" || result.USBPID != "0000" {
			t.Fatalf("expired identity proof changed candidate metadata: result=%#v err=%v", result, err)
		}
	}
}
