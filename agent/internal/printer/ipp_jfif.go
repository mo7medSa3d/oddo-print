package printer

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// wrapIPPPayloadAsJFIF inserts the JFIF 1.02 APP0 segment required by IPP
// Everywhere's image/jpeg document format. Go's image/jpeg Encoder produces
// standards-valid JPEG but does not currently emit JFIF APP0 metadata. Many
// embedded printer decoders require the identifier and pixel density.
func wrapIPPPayloadAsJFIF(jpegData []byte, dpi uint16) ([]byte, error) {
	if len(jpegData) < 4 || !bytes.Equal(jpegData[:2], []byte{0xff, 0xd8}) {
		return nil, fmt.Errorf("IPP JPEG payload is not a JPEG codestream")
	}
	if dpi == 0 || dpi > 1200 {
		return nil, fmt.Errorf("invalid JFIF resolution")
	}
	// Existing correct JFIF metadata should not be duplicated; a malformed
	// claimed JFIF header is rejected rather than silently overwritten.
	if len(jpegData) >= 20 &&
		bytes.Equal(jpegData[2:4], []byte{0xff, 0xe0}) &&
		bytes.Equal(jpegData[6:11], []byte("JFIF\x00")) {
		return jpegData, nil
	}
	const app0Len = 18
	if len(jpegData) > maxPrintBytes-app0Len {
		return nil, fmt.Errorf("IPP JFIF output exceeds the print job size limit")
	}
	segment := make([]byte, app0Len)
	copy(segment[:4], []byte{0xff, 0xe0, 0x00, 0x10})
	copy(segment[4:9], []byte("JFIF\x00"))
	segment[9] = 1  // major 1
	segment[10] = 2 // minor 2
	segment[11] = 1 // pixel density units: dots per inch
	binary.BigEndian.PutUint16(segment[12:14], dpi)
	binary.BigEndian.PutUint16(segment[14:16], dpi)
	// segment[16] and segment[17] == 0 (no thumbnail)
	out := make([]byte, 0, len(jpegData)+app0Len)
	out = append(out, jpegData[:2]...)
	out = append(out, segment...)
	out = append(out, jpegData[2:]...)
	return out, nil
}
