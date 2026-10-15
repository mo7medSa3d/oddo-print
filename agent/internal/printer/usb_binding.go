package printer

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// Paths remain opaque: only Windows' current USBPRINT interface association
// authorizes a direct printer handle, never a path prefix or VID/PID substring.
type usbPrintInterface struct {
	path       string
	instanceID string
	devInst    uint32
}

func usbHardwareIdentity(instanceID string) (uint16, uint16, string, bool) {
	parts := strings.Split(instanceID, `\`)
	if len(parts) != 3 || !strings.EqualFold(parts[0], "USB") || parts[2] == "" {
		return 0, 0, "", false
	}
	hardware := strings.ToUpper(parts[1])
	if len(hardware) < 17 || hardware[:4] != "VID_" || hardware[8:13] != "&PID_" ||
		(len(hardware) > 17 && hardware[17] != '&') {
		return 0, 0, "", false
	}
	for _, digit := range hardware[4:8] + hardware[13:17] {
		if !(digit >= '0' && digit <= '9') && !(digit >= 'A' && digit <= 'F') {
			return 0, 0, "", false
		}
	}
	vid, vidErr := strconv.ParseUint(hardware[4:8], 16, 16)
	pid, pidErr := strconv.ParseUint(hardware[13:17], 16, 16)
	if vidErr != nil || pidErr != nil {
		return 0, 0, "", false
	}
	return uint16(vid), uint16(pid), parts[2], true
}

func nearestUSBHardwareInstance(ctx context.Context, iface usbPrintInterface, parent func(uint32) (uint32, error), instanceID func(uint32) (string, error)) (string, error) {
	current, id := iface.devInst, iface.instanceID
	seen := make(map[uint32]struct{})
	for depth := 0; depth < 16; depth++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if _, exists := seen[current]; exists {
			return "", fmt.Errorf("USB device ancestry contains a cycle")
		}
		seen[current] = struct{}{}
		if _, _, _, ok := usbHardwareIdentity(id); ok {
			return id, nil
		}
		var err error
		current, err = parent(current)
		if err != nil {
			return "", fmt.Errorf("USB printer hardware parent: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		id, err = instanceID(current)
		if err != nil {
			return "", fmt.Errorf("USB printer hardware identity: %w", err)
		}
	}
	return "", fmt.Errorf("USB printer hardware ancestry exceeds 16 device nodes")
}

func validateUSBPrintBinding(ctx context.Context, path string, vid, pid uint16, serial string, interfaces []usbPrintInterface, parent func(uint32) (uint32, error), instanceID func(uint32) (string, error)) error {
	var selected *usbPrintInterface
	for i := range interfaces {
		if !strings.EqualFold(interfaces[i].path, path) {
			continue
		}
		if selected != nil && (!strings.EqualFold(selected.instanceID, interfaces[i].instanceID) || selected.devInst != interfaces[i].devInst) {
			return fmt.Errorf("configured path has ambiguous USBPRINT device associations")
		}
		selected = &interfaces[i]
	}
	if selected == nil {
		return fmt.Errorf("configured path is not a currently present Windows USBPRINT interface; use its installed Windows spooler queue")
	}
	hardwareID, err := nearestUSBHardwareInstance(ctx, *selected, parent, instanceID)
	if err != nil {
		return err
	}
	actualVID, actualPID, hardwareSerial, _ := usbHardwareIdentity(hardwareID)
	if actualVID != vid || actualPID != pid {
		return fmt.Errorf("USBPRINT identity mismatch: configured VID:%04x PID:%04x, Windows reports VID:%04x PID:%04x", vid, pid, actualVID, actualPID)
	}
	serial = strings.TrimSpace(serial)
	if serial != "" {
		// Existing inventory uses the USBPRINT instance suffix. Its physical USB
		// parent may expose a different serial, but both refer to this interface.
		parts := strings.Split(selected.instanceID, `\`)
		interfaceSerial := ""
		if len(parts) == 3 {
			interfaceSerial = parts[2]
		}
		if !strings.EqualFold(serial, interfaceSerial) && !strings.EqualFold(serial, hardwareSerial) {
			return fmt.Errorf("USBPRINT serial mismatch for the configured device")
		}
	}
	return ctx.Err()
}

func enrichUSBDiscoveryIdentity(ctx context.Context, info DeviceInfo, iface usbPrintInterface, parent func(uint32) (uint32, error), instanceID func(uint32) (string, error)) (DeviceInfo, error) {
	if iface.path == "" || !strings.EqualFold(info.Endpoint, iface.path) {
		return info, fmt.Errorf("no matching native USBPRINT interface for discovered device")
	}
	hardwareID, err := nearestUSBHardwareInstance(ctx, iface, parent, instanceID)
	if err != nil {
		return info, err
	}
	vid, pid, _, _ := usbHardwareIdentity(hardwareID)
	// Keep the already assigned legacy ID, native path and inventory serial.
	info.USBVID, info.USBPID = fmt.Sprintf("%04x", vid), fmt.Sprintf("%04x", pid)
	return info, nil
}

func refreshNativeUSBDiscoveryIDs(existing, incoming DeviceInfo) bool {
	if existing.ID == "" || existing.ID != incoming.ID || existing.Endpoint == "" ||
		!strings.EqualFold(existing.Endpoint, incoming.Endpoint) ||
		!strings.EqualFold(existing.ConnectionType, "usb") || !strings.EqualFold(incoming.ConnectionType, "usb") {
		return false
	}
	for _, info := range []DeviceInfo{existing, incoming} {
		source, _ := info.Capabilities["discovered_via"].(string)
		registration, _ := info.Capabilities["registration_source"].(string)
		if source != SourceUSB || (registration != "" && registration != "discovery" && registration != "registry") {
			return false
		}
	}
	verified, _ := incoming.Capabilities["usb_identity_verified"].(bool)
	_, _, _, validIDs := usbHardwareIdentity(`USB\VID_` + incoming.USBVID + "&PID_" + incoming.USBPID + `\validation`)
	return verified && validIDs
}
