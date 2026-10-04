//go:build windows

package printer

import (
	"encoding/binary"
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
