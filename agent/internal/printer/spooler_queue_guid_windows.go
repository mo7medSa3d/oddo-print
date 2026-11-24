//go:build windows

package printer

import (
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// PRINTER_INFO_7 identifies a directory-published logical queue, never a
// physical chassis. Unpublished/pending/unsupported queues have no GUID proof.
type printerInfo7 struct {
	pObjectGUID *uint16
	dwAction    uint32
}

func publishedQueueGUIDFromBuffer(buf []byte) string {
	if uintptr(len(buf)) < unsafe.Sizeof(printerInfo7{}) {
		return ""
	}
	info := (*printerInfo7)(unsafe.Pointer(&buf[0]))
	if info.dwAction != 0x00000001 || info.pObjectGUID == nil {
		return ""
	} // DSPRINT_PUBLISH
	base := uintptr(unsafe.Pointer(&buf[0]))
	pointer := uintptr(unsafe.Pointer(info.pObjectGUID))
	if pointer < base || pointer-base >= uintptr(len(buf)) || (pointer-base)%2 != 0 {
		return ""
	}
	offset := int(pointer - base)
	units := make([]uint16, 0, 39)
	for i := offset; i+1 < len(buf) && len(units) <= 38; i += 2 {
		unit := uint16(buf[i]) | uint16(buf[i+1])<<8
		if unit == 0 {
			text := strings.Trim(string(utf16.Decode(units)), "{}")
			return normalizedIPPPrinterUUID("urn:uuid:" + text)
		}
		units = append(units, unit)
	}
	return ""
}

func publishedQueueGUID(handle syscall.Handle) string {
	const limit = 64 * 1024
	var needed uint32
	ret, _, callErr := procGetPrinterW.Call(uintptr(handle), 7, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if (ret == 0 && !isInsufficientBuffer(callErr)) || uintptr(needed) < unsafe.Sizeof(printerInfo7{}) || needed > limit {
		return ""
	}
	buffer := make([]byte, needed)
	ret, _, _ = procGetPrinterW.Call(uintptr(handle), 7, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&needed)))
	if ret == 0 || needed > uint32(len(buffer)) {
		return ""
	}
	guid := publishedQueueGUIDFromBuffer(buffer)
	runtime.KeepAlive(buffer)
	return guid
}
