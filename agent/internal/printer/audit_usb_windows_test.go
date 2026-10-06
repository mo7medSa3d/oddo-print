//go:build windows

package printer

import (
	"encoding/binary"
	"fmt"
	"syscall"
	"testing"
)

func TestAuditSetupAPIPathStartsAfterDWORDNotStructureSize(t *testing.T) {
	const path = `\\?\usb#vid_04b8&pid_0202#receipt`
	for _, size := range []uint32{6, 8} {
		chars := syscall.StringToUTF16(path)
		buf := make([]byte, 4+2*len(chars))
		binary.LittleEndian.PutUint32(buf, size)
		for i, c := range chars {
			binary.LittleEndian.PutUint16(buf[4+i*2:], c)
		}
		got, err := usbDeviceInterfacePath(buf)
		if err != nil || got != path {
			t.Fatalf("cbSize %d lost prefix: %q %v", size, got, err)
		}
	}
}

func TestAuditSetupAPIRejectsShortAndNonDevicePaths(t *testing.T) {
	for _, buf := range [][]byte{nil, {1, 2, 3}, {0, 0, 0, 0, 65, 0, 0, 0}} {
		if _, err := usbDeviceInterfacePath(buf); err == nil {
			t.Fatalf("accepted invalid buffer: %v", buf)
		}
	}
}

func TestAuditUSBPrintInterfaceGUIDMatchesMicrosoft(t *testing.T) {
	// GUID_DEVINTERFACE_USBPRINT per Microsoft usbprint.h:
	// {28D78FAD-5A12-11d1-AE5B-0000F803A8C2}. A wrong GUID makes primary
	// USB printer discovery and path enumeration target an unrelated
	// device-interface class (previously 100a-48d4, which matches nothing
	// printer-specific). Format the constant the way SetupDi consumers
	// render interface paths so drift is caught textually.
	got := fmt.Sprintf("{%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x}",
		guidDevInterfaceUSBPrint.Data1, guidDevInterfaceUSBPrint.Data2, guidDevInterfaceUSBPrint.Data3,
		guidDevInterfaceUSBPrint.Data4[0], guidDevInterfaceUSBPrint.Data4[1],
		guidDevInterfaceUSBPrint.Data4[2], guidDevInterfaceUSBPrint.Data4[3],
		guidDevInterfaceUSBPrint.Data4[4], guidDevInterfaceUSBPrint.Data4[5],
		guidDevInterfaceUSBPrint.Data4[6], guidDevInterfaceUSBPrint.Data4[7])
	const want = "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}"
	if got != want {
		t.Fatalf("USBPRINT interface GUID drift: got %s want %s", got, want)
	}
}
