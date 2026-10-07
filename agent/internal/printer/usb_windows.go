//go:build windows

package printer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// usbChunkTimeout bounds a single synchronous 8KB WriteFile call. A healthy
// USB bulk transfer completes an 8KB chunk in single-digit milliseconds, so
// 30s is orders of magnitude of headroom yet finite; it matches the
// spooler's bounded unknown window, keeping the forensic meaning of a
// timeout identical across transports. Overridable in tests.
var usbChunkTimeout = 30 * time.Second

type USBPrinter struct {
	ID             string
	Name           string
	VID            uint16
	PID            uint16
	SerialNumber   string
	DevicePath     string
	USBLocation    string
	Protocol       string
	SupportsESCPOS bool
	// writeChunk performs one synchronous kernel write; injected in tests.
	writeChunk func(h windows.Handle, chunk []byte) (uint32, error)
	// closeHandle releases the Windows device handle; injected in tests so
	// ownership transfer on abandoned writes can be asserted without races.
	closeHandle func(h windows.Handle) error
	// wedged latches once a chunk write had to be abandoned mid-syscall.
	// Only pointer receivers ever exist (see factory.go), so atomic access
	// is race-safe.
	wedged atomic.Bool
}

// defaultUSBWriteChunk is the real synchronous Win32 write.
func defaultUSBWriteChunk(h windows.Handle, chunk []byte) (uint32, error) {
	var n uint32
	err := windows.WriteFile(h, chunk, &n, nil)
	return n, err
}

type usbChunkResult struct {
	n   uint32
	err error
}

// closeDeviceHandle centralizes handle release so the normal caller-owned path
// and the abandoned helper-owned path cannot accidentally use different close
// semantics. Close errors are diagnostic only: the physical print outcome was
// already determined by the write path.
func (p *USBPrinter) closeDeviceHandle(h windows.Handle) {
	closeFn := p.closeHandle
	if closeFn == nil {
		closeFn = windows.CloseHandle
	}
	if err := closeFn(h); err != nil {
		log.Printf("WARNING: CloseHandle failed for USB device %s: %v", p.Identify(), err)
	}
}

// writeChunkBounded executes one chunk write on a helper goroutine so the
// CALLER is bounded even when the kernel/driver call never returns. This
// does NOT cancel the kernel write (a synchronous WriteFile cannot be
// interrupted by the Go context, and Microsoft documents thread-targeted
// CancelSynchronousIo as only an attempted cancellation whose driver support
// is not guaranteed).
//
// The third return value reports HANDLE OWNERSHIP TRANSFER. This is required
// because cancellation can win immediately after the helper goroutine is
// created but before it has entered WriteFile. Closing the handle in Print at
// that point would let the helper later issue I/O through an invalid or reused
// numeric handle. Therefore:
//   - normal completion: the helper publishes its result, receives a
//     keep-open decision, and Print remains the sole handle owner;
//   - timeout/cancellation: Print transfers ownership before returning; the
//     helper closes the handle exactly once after WriteFile eventually returns.
//
// The chunk slice is captured by the helper closure, so the Go collector keeps
// its backing array alive until the write returns.
func (p *USBPrinter) writeChunkBounded(h windows.Handle, chunk []byte, cancel <-chan struct{}) (uint32, error, bool) {
	write := p.writeChunk
	if write == nil {
		write = defaultUSBWriteChunk
	}
	done := make(chan usbChunkResult, 1)
	closeWhenDone := make(chan bool, 1)
	go func() {
		n, err := write(h, chunk)
		done <- usbChunkResult{n, err}
		if <-closeWhenDone {
			p.closeDeviceHandle(h)
		}
	}()
	timer := time.NewTimer(usbChunkTimeout)
	defer timer.Stop()
	select {
	case r := <-done:
		closeWhenDone <- false
		return r.n, r.err, false
	case <-cancel:
		p.wedged.Store(true)
		closeWhenDone <- true
		return 0, MarkUnknown("USB write to %s abandoned on cancellation after an unknown number of transmitted bytes (kernel write not interruptible)", p.DevicePath), true
	case <-timer.C:
		p.wedged.Store(true)
		closeWhenDone <- true
		return 0, MarkUnknown("USB write to %s exceeded the %v operation boundary with an unknown number of transmitted bytes (kernel write not interruptible)", p.DevicePath, usbChunkTimeout), true
	}
}

func (p *USBPrinter) Identify() string {
	if p.SerialNumber != "" && p.SerialNumber != "0" {
		return fmt.Sprintf("USB-SN:%s", p.SerialNumber)
	}
	if p.USBLocation != "" {
		return fmt.Sprintf("USB-LOC:%s", p.USBLocation)
	}
	return fmt.Sprintf("USB-VIDPID:%04x:%04x", p.VID, p.PID)
}

func (p *USBPrinter) Print(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(data), maxPrintBytes)
	}
	// A printer wedged by an abandoned in-flight kernel write (see
	// writeChunkBounded) must not accept new dispatches: the stuck write may
	// still complete and emit bytes, so interleaving a new job would corrupt
	// output AND risk a duplicate physical print. Fail fast, pre-dispatch,
	// until the process restarts (the latch is in-memory by design).
	if p.wedged.Load() {
		return fmt.Errorf("USB device %s is wedged after a stalled write; refusing new dispatch (restart the agent to clear)", p.Identify())
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if p.DevicePath == "" {
		return fmt.Errorf("USB device discovered (%s) but no Windows device path is available and no spooler queue is associated; install the printer as a Windows printer (Settings > Bluetooth & devices > Printers) and use type spooler with spooler_name %q. VID:%04x PID:%04x Serial:%q", p.Identify(), p.Name, p.VID, p.PID, p.SerialNumber)
	}
	pathPtr, err := syscall.UTF16PtrFromString(p.DevicePath)
	if err != nil {
		return fmt.Errorf("invalid device path %q: %w", p.DevicePath, err)
	}
	h, err := windows.CreateFile(pathPtr, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return fmt.Errorf("CreateFile(%q) failed for %s: %w (try installing as Windows spooler queue)", p.DevicePath, p.Identify(), err)
	}
	callerOwnsHandle := true
	defer func() {
		if callerOwnsHandle {
			p.closeDeviceHandle(h)
		}
	}()
	if err := runDispatchAdmission(ctx); err != nil {
		return fmt.Errorf("USB print admission refused: %w", err)
	}
	written := 0
	for written < len(data) {
		select {
		case <-ctx.Done():
			// Checked BEFORE spawning the write helper: this attempt
			// provably sent zero bytes, so a plain error stays honest.
			if written > 0 {
				return MarkUnknown("print cancelled after %d/%d bytes: %v", written, len(data), ctx.Err())
			}
			return fmt.Errorf("print cancelled after %d/%d bytes: %w", written, len(data), ctx.Err())
		default:
		}
		chunk := data[written:]
		if len(chunk) > 8192 {
			chunk = chunk[:8192]
		}
		// Once the helper is spawned the kernel may accept bytes even if
		// the caller gives up while waiting: every failure from this point
		// is UNKNOWN unless the write provably failed with zero confirmed
		// bytes. writeChunkBounded already classifies timeouts and
		// in-flight cancellations as unknown; pass those through verbatim.
		n, err, handleTransferred := p.writeChunkBounded(h, chunk, ctx.Done())
		if handleTransferred {
			callerOwnsHandle = false
		}
		if err != nil {
			if n > 0 {
				written += int(n)
				return MarkUnknown("WriteFile to %s returned an error after %d/%d bytes: %v", p.DevicePath, written, len(data), err)
			}
			if HasUnknownOutcomeMarker(err.Error()) {
				return err
			}
			if written > 0 {
				return MarkUnknown("WriteFile to %s failed after %d/%d bytes: %v", p.DevicePath, written, len(data), err)
			}
			return fmt.Errorf("WriteFile to %s failed after %d/%d bytes: %w", p.DevicePath, written, len(data), err)
		}
		if n == 0 {
			if written > 0 {
				return MarkUnknown("WriteFile to %s wrote 0 bytes after %d/%d", p.DevicePath, written, len(data))
			}
			return fmt.Errorf("WriteFile to %s wrote 0 bytes", p.DevicePath)
		}
		if int64(n) > int64(len(chunk)) {
			// A driver/helper that reports more bytes than the submitted
			// chunk is faulty and the wire state is uncertain: report
			// UNKNOWN with the honestly confirmed byte count (bytes
			// accepted before this chunk). The counter is NOT advanced to
			// the payload size — a fabricated total must never read as
			// completion evidence.
			return MarkUnknown("WriteFile to %s over-reported %d bytes for a %d-byte chunk after %d/%d confirmed bytes", p.DevicePath, n, len(chunk), written, len(data))
		}
		written += int(n)
	}
	log.Printf("Direct USB printed %d bytes to %s (%s)", written, p.DevicePath, p.Identify())
	return nil
}

// Printer-language diagnostic tickets interpolate operator-controlled display
// names. Strip command delimiters rather than escaping them ambiguously:
// diagnostic labels do not need those characters, and a crafted queue name
// must never terminate a field or inject another command.
func sanitizeZPLTestText(s string) string {
	return strings.NewReplacer("^", " ", "~", " ").Replace(sanitizeTestText(s))
}

func sanitizeTSPLTestText(s string) string {
	return strings.NewReplacer("\"", "'", "\\", "/").Replace(sanitizeTestText(s))
}

// SessionMayBeLive implements LiveSessionReporter: a wedged latch means an
// abandoned kernel write may still complete and emit bytes. A replacement
// backend starts with a fresh latch, so swapping while wedged would permit a
// new submission to interleave with the stuck write.
func (p *USBPrinter) SessionMayBeLive() bool {
	return p.wedged.Load()
}

func (p *USBPrinter) testPayload() []byte {
	name := sanitizeTestText(p.Name)
	switch strings.ToLower(strings.TrimSpace(p.Protocol)) {
	case "escpos":
		// ESC/POS control bytes are sent only when the configured protocol
		// explicitly declares ESC/POS. Do not cut by default: cutter support is
		// a separate capability and cannot be inferred from USB/thermal class.
		return []byte("\x1b\x40USB Direct Test Print for Yaseir Agent\nPrinter: " + name + "\nVID:" + fmt.Sprintf("%04x", p.VID) + " PID:" + fmt.Sprintf("%04x", p.PID) + "\n\n")
	case "zpl":
		zplName := sanitizeZPLTestText(name)
		return []byte("^XA\n^FO40,40^A0N,30,30^FDYASEIR USB TEST^FS\n^FO40,80^A0N,24,24^FDPrinter: " + zplName + "^FS\n^XZ\n")
	case "tspl":
		tsplName := sanitizeTSPLTestText(name)
		return []byte("SIZE 75 mm, 40 mm\nGAP 2 mm, 0 mm\nCLS\nTEXT 30,30,\"3\",0,1,1,\"YASEIR USB TEST\"\nTEXT 30,70,\"2\",0,1,1,\"Printer: " + tsplName + "\"\nPRINT 1,1\n")
	default:
		// Generic raw USB diagnostics use printable ASCII only. A raw byte
		// stream is not evidence that the device understands ESC/POS commands.
		return []byte("USB Direct Test Print for Yaseir Agent\r\nPrinter: " + name + "\r\nVID:" + fmt.Sprintf("%04x", p.VID) + " PID:" + fmt.Sprintf("%04x", p.PID) + "\r\n\r\n")
	}
}

func (p *USBPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, p.testPayload())
}

func (p *USBPrinter) Status() string {
	if p.DevicePath == "" {
		return "unknown"
	}
	pathPtr, err := syscall.UTF16PtrFromString(p.DevicePath)
	if err != nil {
		return "error"
	}
	h, err := windows.CreateFile(pathPtr, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		// Access/sharing/service-context failures do not prove physical absence.
		return "unknown"
	}
	windows.CloseHandle(h)
	// A successful interface open proves transport accessibility only; USBPRINT
	// exposes no generic media/cover/readiness state. Keep physical health unknown.
	return "unknown"
}

const (
	digcfPresent             = 0x00000002
	digcfAllClasses          = 0x00000004
	digcfDeviceInterface     = 0x00000010
	spdrpHardwareID          = 0x00000001
	spdrpCompatibleIDs       = 0x00000002
	spdrpDeviceDesc          = 0x00000000
	spdrpFriendlyName        = 0x0000000C
	spdrpLocationInformation = 0x0000000D
	spdrpMfg                 = 0x0000000B
	spdrpClass               = 0x00000007
	spdrpClassGuid           = 0x00000008
)

var (
	modSetupAPI                           = syscall.NewLazyDLL("setupapi.dll")
	procSetupDiGetClassDevsW              = modSetupAPI.NewProc("SetupDiGetClassDevsW")
	procSetupDiEnumDeviceInfo             = modSetupAPI.NewProc("SetupDiEnumDeviceInfo")
	procSetupDiGetDeviceInstanceIdW       = modSetupAPI.NewProc("SetupDiGetDeviceInstanceIdW")
	procSetupDiGetDeviceRegistryPropertyW = modSetupAPI.NewProc("SetupDiGetDeviceRegistryPropertyW")
	procSetupDiDestroyDeviceInfoList      = modSetupAPI.NewProc("SetupDiDestroyDeviceInfoList")
	procSetupDiEnumDeviceInterfaces       = modSetupAPI.NewProc("SetupDiEnumDeviceInterfaces")
	procSetupDiGetDeviceInterfaceDetailW  = modSetupAPI.NewProc("SetupDiGetDeviceInterfaceDetailW")
)

type spDevInfoData struct {
	cbSize    uint32
	ClassGuid windows.GUID
	DevInst   uint32
	Reserved  uintptr
}

type spDeviceInterfaceData struct {
	cbSize             uint32
	InterfaceClassGuid windows.GUID
	Flags              uint32
	Reserved           uintptr
}

// GUID_DEVINTERFACE_USBPRINT from Microsoft usbprint.h
// (https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/shared/usbprint.h):
// USBPRINT {28D78FAD-5A12-11d1-AE5B-0000F803A8C2}. This is the
// printer-specific device-interface class; enumerating any other GUID here
// misses real USB printers (or matches unrelated USB devices).
var guidDevInterfaceUSBPrint = windows.GUID{Data1: 0x28d78fad, Data2: 0x5a12, Data3: 0x11d1, Data4: [8]byte{0xae, 0x5b, 0x00, 0x00, 0xf8, 0x03, 0xa8, 0xc2}}

func discoverUSBPrinters() ([]DeviceInfo, error) {
	log.Printf("[discovery] starting USB discovery (SetupDi)")
	pathMap, pathErr := buildUSBDevicePathMap()
	var diagnostics []error
	if pathErr != nil {
		diagnostics = append(diagnostics, pathErr)
	}

	// Prefer printer-specific interface GUID; fallback to ALLCLASSES with strict filtering
	handle, _, err := procSetupDiGetClassDevsW.Call(uintptr(unsafe.Pointer(&guidDevInterfaceUSBPrint)), 0, 0, uintptr(digcfPresent|digcfDeviceInterface))
	primaryAvailable := handle != uintptr(0) && handle != ^uintptr(0)
	if primaryAvailable {
		defer procSetupDiDestroyDeviceInfoList.Call(handle)
	} else {
		diagnostics = append(diagnostics, fmt.Errorf("USBPRINT SetupDiGetClassDevsW failed: %v", err))
	}

	var infos []DeviceInfo
	seenIDs := make(map[string]bool)

	for idx := 0; primaryAvailable; idx++ {
		var devInfo spDevInfoData
		devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
		ret, _, enumErr := procSetupDiEnumDeviceInfo.Call(handle, uintptr(idx), uintptr(unsafe.Pointer(&devInfo)))
		if ret == 0 {
			if enumErr != windows.ERROR_NO_MORE_ITEMS {
				diagnostics = append(diagnostics, fmt.Errorf("USB device enumeration: %v", enumErr))
			}
			break
		}
		instanceID, err := getDeviceInstanceID(handle, &devInfo)
		if err != nil || instanceID == "" {
			continue
		}
		upperID := strings.ToUpper(instanceID)
		isUSB := strings.Contains(upperID, "USB\\VID_") || strings.Contains(upperID, "USBPRINT") || strings.Contains(upperID, "VID_") && strings.Contains(upperID, "PID_")
		if !isUSB {
			continue
		}
		hwIDs, hwErr := getDeviceRegistryProperty(handle, &devInfo, spdrpHardwareID)
		compatIDs, compatErr := getDeviceRegistryProperty(handle, &devInfo, spdrpCompatibleIDs)
		classVal, classErr := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpClass)
		keep, incomplete := keepPrimaryUSBDevice(hwIDs, compatIDs, classVal, hwErr, compatErr, classErr)
		if !keep {
			// Properties read successfully and the device is
			// affirmatively not printer-like: skip it.
			continue
		}
		enrichmentIncomplete := incomplete
		if enrichmentIncomplete {
			// Optional enrichment failed, but enumeration under the
			// printer-specific USBPRINT interface GUID is itself
			// affirmative printer evidence. Preserve the device and
			// surface the incomplete enrichment separately instead of
			// discarding a real printer over an unreadable property.
			diagnostics = append(diagnostics, fmt.Errorf("USB device %q: hardware/class properties unreadable (hw:%v compat:%v class:%v); keeping interface-enumerated device with incomplete enrichment", instanceID, hwErr, compatErr, classErr))
		}
		vid, pid, serial := parseVIDPIDSerial(instanceID)
		friendlyName, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpFriendlyName)
		if friendlyName == "" {
			friendlyName, _ = getDeviceRegistryPropertySingle(handle, &devInfo, spdrpDeviceDesc)
		}
		mfg, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpMfg)
		location, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpLocationInformation)
		desc, _ := getDeviceRegistryPropertySingle(handle, &devInfo, spdrpDeviceDesc)
		if friendlyName == "" {
			friendlyName = desc
		}
		if friendlyName == "" {
			friendlyName = fmt.Sprintf("USB Printer %04X:%04X", vid, pid)
		}
		friendlyName = strings.TrimSpace(friendlyName)
		if mfg != "" && !strings.Contains(strings.ToLower(friendlyName), strings.ToLower(mfg)) {
			friendlyName = mfg + " " + friendlyName
		}
		vidStr := fmt.Sprintf("%04x", vid)
		pidStr := fmt.Sprintf("%04x", pid)
		id := StableIDFromUSBFull(vidStr, pidStr, serial, location, instanceID)
		if seenIDs[id] {
			continue
		}
		seenIDs[id] = true

		devicePath := pathMap[instanceID]
		if devicePath == "" {
			for k, v := range pathMap {
				if strings.EqualFold(k, instanceID) {
					devicePath = v
					break
				}
			}
		}

		caps := map[string]interface{}{}
		caps["discovered_via"] = SourceUSB
		caps["hardware_ids"] = hwIDs
		caps["compatible_ids"] = compatIDs
		caps["device_instance_id"] = instanceID
		if enrichmentIncomplete {
			caps["enrichment_incomplete"] = true
		}
		if mfg != "" {
			caps["manufacturer"] = mfg
		}
		if desc != "" {
			caps["device_desc"] = desc
		}
		if location != "" {
			caps["location"] = location
		}
		if devicePath != "" {
			caps["device_path"] = devicePath
			caps["direct_usb_available"] = true
			caps["requires_spooler"] = false
			caps["verification"] = "candidate_only"
			caps["diagnostic"] = "Direct USB interface is available, but printer language is not proven; select raw/escpos/zpl/tspl explicitly before enabling direct USB execution"
		} else {
			caps["diagnostic"] = "USB device discovered, no device path found; install as Windows spooler queue or ensure driver exposes USBPRINT interface"
			caps["verification"] = "candidate_only"
			caps["requires_spooler"] = true
			caps["direct_usb_available"] = false
		}

		di := DeviceInfo{
			ID:             id,
			Name:           friendlyName,
			DisplayName:    friendlyName,
			PrinterType:    "unknown",
			ConnectionType: "usb",
			Protocol:       "unknown",
			Endpoint:       devicePath,
			SpoolerName:    "",
			USBVID:         vidStr,
			USBPID:         pidStr,
			USBSerial:      serial,
			Status:         "unknown",
			Enabled:        true,
			Capabilities:   caps,
			Type:           "usb",
		}
		if devicePath == "" {
			diagnostics = append(diagnostics, fmt.Errorf("USB printer %q has no direct path; install its Windows spooler queue", friendlyName))
		}
		lowerName := strings.ToLower(friendlyName + " " + desc + " " + mfg)
		if strings.Contains(lowerName, "thermal") || strings.Contains(lowerName, "receipt") || strings.Contains(lowerName, "pos") {
			di.PrinterType = "thermal"
		} else if strings.Contains(lowerName, "label") || strings.Contains(lowerName, "zebra") {
			di.PrinterType = "label"
		} else if strings.Contains(lowerName, "laser") {
			di.PrinterType = "laser"
		} else if strings.Contains(lowerName, "inkjet") || strings.Contains(lowerName, "deskjet") {
			di.PrinterType = "inkjet"
		}
		// USBPRINT interface presence is inventory evidence, not physical readiness.
		// Runtime status remains unknown unless a protocol-specific backend can
		// report a real device state.
		log.Printf("[discovery] found USB printer: %q VID:%04x PID:%04x serial:%q location:%q path:%q -> %s", friendlyName, vid, pid, serial, location, devicePath, id)
		infos = append(infos, di)
	}
	// Fallback enumeration via ALLCLASSES with strict filtering to catch vendor-specific
	// printers that do not expose GUID_DEVINTERFACE_USBPRINT but still have Class_07.
	// Always supplement primary results; one standard printer must not hide vendor-specific ones.
	{
		fbHandle, _, fallbackErr := procSetupDiGetClassDevsW.Call(0, 0, 0, uintptr(digcfPresent|digcfAllClasses))
		if fbHandle != uintptr(0) && fbHandle != ^uintptr(0) {
			defer procSetupDiDestroyDeviceInfoList.Call(fbHandle)
			for idx := 0; ; idx++ {
				var devInfo spDevInfoData
				devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
				ret, _, enumErr := procSetupDiEnumDeviceInfo.Call(fbHandle, uintptr(idx), uintptr(unsafe.Pointer(&devInfo)))
				if ret == 0 {
					if enumErr != windows.ERROR_NO_MORE_ITEMS {
						diagnostics = append(diagnostics, fmt.Errorf("USB fallback enumeration: %v", enumErr))
					}
					break
				}
				instanceID, err := getDeviceInstanceID(fbHandle, &devInfo)
				if err != nil || instanceID == "" {
					continue
				}
				upperID := strings.ToUpper(instanceID)
				if !(strings.Contains(upperID, "USB\\VID_") || strings.Contains(upperID, "USBPRINT")) {
					continue
				}
				hwIDs, _ := getDeviceRegistryProperty(fbHandle, &devInfo, spdrpHardwareID)
				compatIDs, _ := getDeviceRegistryProperty(fbHandle, &devInfo, spdrpCompatibleIDs)
				classVal, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpClass)
				if !isPrinterUSBDevice(hwIDs, compatIDs, classVal) {
					continue
				}
				vid, pid, serial := parseVIDPIDSerial(instanceID)
				friendlyName, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpFriendlyName)
				if friendlyName == "" {
					friendlyName, _ = getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpDeviceDesc)
				}
				mfg, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpMfg)
				location, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpLocationInformation)
				desc, _ := getDeviceRegistryPropertySingle(fbHandle, &devInfo, spdrpDeviceDesc)
				if friendlyName == "" {
					friendlyName = desc
				}
				if friendlyName == "" {
					friendlyName = fmt.Sprintf("USB Printer %04X:%04X", vid, pid)
				}
				friendlyName = strings.TrimSpace(friendlyName)
				if mfg != "" && !strings.Contains(strings.ToLower(friendlyName), strings.ToLower(mfg)) {
					friendlyName = mfg + " " + friendlyName
				}
				vidStr := fmt.Sprintf("%04x", vid)
				pidStr := fmt.Sprintf("%04x", pid)
				id := StableIDFromUSBFull(vidStr, pidStr, serial, location, instanceID)
				if seenIDs[id] {
					continue
				}
				seenIDs[id] = true
				devicePath := pathMap[instanceID]
				if devicePath == "" {
					for k, v := range pathMap {
						if strings.EqualFold(k, instanceID) {
							devicePath = v
							break
						}
					}
				}
				caps := map[string]interface{}{}
				caps["discovered_via"] = SourceUSB
				caps["hardware_ids"] = hwIDs
				caps["compatible_ids"] = compatIDs
				caps["device_instance_id"] = instanceID
				if mfg != "" {
					caps["manufacturer"] = mfg
				}
				if desc != "" {
					caps["device_desc"] = desc
				}
				if location != "" {
					caps["location"] = location
				}
				caps["device_path"] = devicePath
				caps["direct_usb_available"] = devicePath != ""
				caps["requires_spooler"] = devicePath == ""
				caps["verification"] = "candidate_only"
				if devicePath == "" {
					caps["diagnostic"] = "USB printer has no direct device path; install its Windows spooler queue"
				} else {
					caps["diagnostic"] = "Direct USB interface is available, but printer language is not proven; select raw/escpos/zpl/tspl explicitly before enabling direct USB execution"
				}
				di := DeviceInfo{
					ID:             id,
					Name:           friendlyName,
					DisplayName:    friendlyName,
					PrinterType:    "unknown",
					ConnectionType: "usb",
					Protocol:       "unknown",
					Endpoint:       devicePath,
					USBVID:         vidStr,
					USBPID:         pidStr,
					USBSerial:      serial,
					Status:         "unknown",
					Enabled:        true,
					Capabilities:   caps,
					Type:           "usb",
				}
				if devicePath == "" {
					di.Status = "unknown"
					diagnostics = append(diagnostics, fmt.Errorf("USB printer %q has no direct path; install its Windows spooler queue", friendlyName))
				}
				lowerName := strings.ToLower(friendlyName + " " + desc + " " + mfg)
				if strings.Contains(lowerName, "thermal") || strings.Contains(lowerName, "receipt") || strings.Contains(lowerName, "pos") {
					di.PrinterType = "thermal"
				} else if strings.Contains(lowerName, "label") || strings.Contains(lowerName, "zebra") {
					di.PrinterType = "label"
				} else if strings.Contains(lowerName, "laser") {
					di.PrinterType = "laser"
				} else if strings.Contains(lowerName, "inkjet") || strings.Contains(lowerName, "deskjet") {
					di.PrinterType = "inkjet"
				}
				log.Printf("[discovery] found USB printer via fallback: %q VID:%04x PID:%04x -> %s", friendlyName, vid, pid, id)
				infos = append(infos, di)
			}
		} else {
			diagnostics = append(diagnostics, fmt.Errorf("USB fallback SetupDiGetClassDevsW failed: %v", fallbackErr))
		}
	}
	log.Printf("[discovery] USB discovery completed: %d devices", len(infos))
	return infos, errors.Join(diagnostics...)
}

func buildUSBDevicePathMap() (map[string]string, error) {
	out := make(map[string]string)
	var diagnostics []error
	// Generic USB interfaces do not promise a printer WriteFile transport.
	// Keep those devices as fallback candidates requiring a spooler queue.
	guids := []windows.GUID{guidDevInterfaceUSBPrint}
	for _, guid := range guids {
		handle, _, classErr := procSetupDiGetClassDevsW.Call(uintptr(unsafe.Pointer(&guid)), 0, 0, uintptr(digcfPresent|digcfDeviceInterface))
		if handle == uintptr(0) || handle == ^uintptr(0) {
			diagnostics = append(diagnostics, fmt.Errorf("USB path interface set: %v", classErr))
			continue
		}
		for idx := 0; ; idx++ {
			var ifData spDeviceInterfaceData
			ifData.cbSize = uint32(unsafe.Sizeof(ifData))
			ret, _, enumErr := procSetupDiEnumDeviceInterfaces.Call(handle, 0, uintptr(unsafe.Pointer(&guid)), uintptr(idx), uintptr(unsafe.Pointer(&ifData)))
			if ret == 0 {
				if enumErr != windows.ERROR_NO_MORE_ITEMS {
					diagnostics = append(diagnostics, fmt.Errorf("USB path enumeration: %v", enumErr))
				}
				break
			}
			var required uint32
			ret, _, detailErr := procSetupDiGetDeviceInterfaceDetailW.Call(handle, uintptr(unsafe.Pointer(&ifData)), 0, 0, uintptr(unsafe.Pointer(&required)), 0)
			if ret == 0 && detailErr != windows.ERROR_INSUFFICIENT_BUFFER {
				diagnostics = append(diagnostics, fmt.Errorf("USB path detail sizing: %v", detailErr))
				continue
			}
			if required < 6 || required > 4096 {
				diagnostics = append(diagnostics, fmt.Errorf("USB path detail invalid size %d", required))
				continue
			}
			buf := make([]byte, required)
			cbSize := 6
			if unsafe.Sizeof(uintptr(0)) == 8 {
				cbSize = 8
			}
			*(*uint32)(unsafe.Pointer(&buf[0])) = uint32(cbSize)
			var devInfo spDevInfoData
			devInfo.cbSize = uint32(unsafe.Sizeof(devInfo))
			ret, _, detailErr = procSetupDiGetDeviceInterfaceDetailW.Call(handle, uintptr(unsafe.Pointer(&ifData)), uintptr(unsafe.Pointer(&buf[0])), uintptr(required), uintptr(unsafe.Pointer(&required)), uintptr(unsafe.Pointer(&devInfo)))
			if ret == 0 {
				diagnostics = append(diagnostics, fmt.Errorf("USB path detail: %v", detailErr))
				continue
			}
			path, pathErr := usbDeviceInterfacePath(buf)
			if pathErr != nil {
				diagnostics = append(diagnostics, fmt.Errorf("USB interface detail: %w", pathErr))
				continue
			}
			instanceID, err := getDeviceInstanceID(handle, &devInfo)
			if err != nil || instanceID == "" {
				diagnostics = append(diagnostics, fmt.Errorf("USB path device instance: %v", err))
				continue
			}
			if _, exists := out[instanceID]; !exists {
				out[instanceID] = path
			}
		}
		procSetupDiDestroyDeviceInfoList.Call(handle)
	}
	return out, errors.Join(diagnostics...)
}

// DevicePath follows the DWORD at offset 4 on both Win32 and Win64.
// cbSize includes ABI padding and is NOT the offset of DevicePath.
func usbDeviceInterfacePath(buf []byte) (string, error) {
	if len(buf) < 6 || len(buf)%2 != 0 {
		return "", fmt.Errorf("invalid USB interface detail length %d", len(buf))
	}
	chars := make([]uint16, (len(buf)-4)/2)
	for i := range chars {
		chars[i] = uint16(buf[4+i*2]) | uint16(buf[5+i*2])<<8
	}
	path := syscall.UTF16ToString(chars)
	if !strings.HasPrefix(path, `\\?\`) && !strings.HasPrefix(path, `\\.\`) {
		return "", fmt.Errorf("invalid USB interface path")
	}
	return path, nil
}

// getDeviceInstanceID reads the device instance ID using the documented
// two-call sizing pattern.
//
// SetupDiGetDeviceInstanceIdW
// (https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetdeviceinstanceidw)
// takes DeviceInstanceIdSize in CHARACTERS, which for the W entry point are
// UTF-16 code units — so []uint16 sized by requiredSize is the correct buffer.
//
// The first call deliberately passes a NULL buffer with a size of zero. It is
// expected to FAIL with ERROR_INSUFFICIENT_BUFFER and populate requiredSize;
// that failure is how the API reports the size. The return value must still be
// checked, because any OTHER failure leaves requiredSize stale or zero and the
// old code would have silently allocated from it.
func getDeviceInstanceID(handle uintptr, devInfo *spDevInfoData) (string, error) {
	var requiredSize uint32
	ret, _, err := procSetupDiGetDeviceInstanceIdW.Call(
		handle,
		uintptr(unsafe.Pointer(devInfo)),
		0,
		0,
		uintptr(unsafe.Pointer(&requiredSize)),
	)
	if ret == 0 && err != windows.ERROR_INSUFFICIENT_BUFFER {
		// A real failure (invalid handle, invalid device element). requiredSize
		// is not meaningful, so sizing from it would be garbage.
		if err == nil || err == syscall.Errno(0) {
			err = fmt.Errorf("GetDeviceInstanceId sizing call failed without an error code")
		}
		return "", fmt.Errorf("SetupDiGetDeviceInstanceIdW sizing failed: %w", err)
	}
	if requiredSize == 0 {
		if err == nil || err == syscall.Errno(0) {
			return "", fmt.Errorf("SetupDiGetDeviceInstanceIdW reported a zero-length instance id")
		}
		return "", fmt.Errorf("SetupDiGetDeviceInstanceIdW reported a zero-length instance id: %w", err)
	}

	buf := make([]uint16, requiredSize)
	ret, _, err = procSetupDiGetDeviceInstanceIdW.Call(
		handle,
		uintptr(unsafe.Pointer(devInfo)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(requiredSize),
		uintptr(unsafe.Pointer(&requiredSize)),
	)
	if ret == 0 {
		// Surface the real spooler/SetupAPI error instead of a bare string:
		// GetLastError is only meaningful after a FALSE return.
		if err == nil || err == syscall.Errno(0) {
			err = fmt.Errorf("unspecified error")
		}
		return "", fmt.Errorf("SetupDiGetDeviceInstanceIdW failed: %w", err)
	}
	return syscall.UTF16ToString(buf), nil
}

func getDeviceRegistryProperty(handle uintptr, devInfo *spDevInfoData, property uint32) ([]string, error) {
	var dataType uint32
	var requiredSize uint32
	ret, _, _ := procSetupDiGetDeviceRegistryPropertyW.Call(handle, uintptr(unsafe.Pointer(devInfo)), uintptr(property), uintptr(unsafe.Pointer(&dataType)), 0, 0, uintptr(unsafe.Pointer(&requiredSize)))
	if ret != 0 || requiredSize == 0 {
		return nil, fmt.Errorf("no data")
	}
	if requiredSize > 8192 {
		requiredSize = 8192
	}
	buf := make([]byte, requiredSize)
	ret, _, err := procSetupDiGetDeviceRegistryPropertyW.Call(handle, uintptr(unsafe.Pointer(devInfo)), uintptr(property), uintptr(unsafe.Pointer(&dataType)), uintptr(unsafe.Pointer(&buf[0])), uintptr(requiredSize), 0)
	if ret == 0 {
		if err == windows.ERROR_INSUFFICIENT_BUFFER || requiredSize == 0 {
			return nil, fmt.Errorf("buffer")
		}
		return nil, err
	}
	if dataType == 1 {
		u16 := (*[4096]uint16)(unsafe.Pointer(&buf[0]))[:requiredSize/2]
		n := 0
		for n < len(u16) && u16[n] != 0 {
			n++
		}
		return []string{syscall.UTF16ToString(u16[:n])}, nil
	} else if dataType == 7 {
		u16 := (*[4096]uint16)(unsafe.Pointer(&buf[0]))[:requiredSize/2]
		var out []string
		start := 0
		for i := 0; i < len(u16); i++ {
			if u16[i] == 0 {
				if i > start {
					out = append(out, syscall.UTF16ToString(u16[start:i]))
				}
				start = i + 1
				if i+1 < len(u16) && u16[i+1] == 0 {
					break
				}
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown type %d", dataType)
}

func getDeviceRegistryPropertySingle(handle uintptr, devInfo *spDevInfoData, property uint32) (string, error) {
	vals, err := getDeviceRegistryProperty(handle, devInfo, property)
	if err != nil || len(vals) == 0 {
		return "", err
	}
	return vals[0], nil
}

func parseVIDPIDSerial(instanceID string) (vid uint16, pid uint16, serial string) {
	upper := strings.ToUpper(instanceID)
	vidIdx := strings.Index(upper, "VID_")
	if vidIdx >= 0 && len(upper) >= vidIdx+8 {
		fmt.Sscanf(upper[vidIdx:vidIdx+8], "VID_%04X", &vid)
	}
	pidIdx := strings.Index(upper, "PID_")
	if pidIdx >= 0 && len(upper) >= pidIdx+8 {
		fmt.Sscanf(upper[pidIdx:pidIdx+8], "PID_%04x", &pid)
		if pid == 0 {
			fmt.Sscanf(upper[pidIdx:pidIdx+8], "PID_%04X", &pid)
		}
	}
	if idx := strings.LastIndex(instanceID, "\\"); idx >= 0 && idx+1 < len(instanceID) {
		serial = instanceID[idx+1:]
		serial = strings.TrimSpace(serial)
		if serial == "0" || strings.EqualFold(serial, "00000000") {
			serial = ""
		}
	}
	return
}

// SupportsKind: a raw USB endpoint is a byte stream with no renderer, exactly
// like RAW TCP — PDF documents must not be written to it.
func (p *USBPrinter) SupportsKind(kind string) bool {
	switch NormalizeKind(kind) {
	case KindRaw:
		return strings.EqualFold(p.Protocol, "raw") ||
			strings.EqualFold(p.Protocol, "escpos") ||
			strings.EqualFold(p.Protocol, "zpl") ||
			strings.EqualFold(p.Protocol, "tspl")
	case KindESCPOS:
		return p.SupportsESCPOS
	default:
		return false
	}
}

// PrintDocument refuses non byte-stream documents instead of writing
// unrenderable bytes to the device.
func (p *USBPrinter) PrintDocument(ctx context.Context, doc Document) error {
	if !p.SupportsKind(doc.Kind) {
		return CapabilityMismatchf("USB printer %s cannot render %s payloads; install it as a Windows printer and route the job to the spooler queue", p.Name, NormalizeKind(doc.Kind))
	}
	return p.Print(ctx, doc.Data)
}
