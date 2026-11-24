package printer

import (
	"encoding/binary"
	"reflect"
	"testing"
	"unicode/utf16"
)

func registryUTF16(text string) []byte {
	units := utf16.Encode([]rune(text))
	buf := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(buf[2*i:], unit)
	}
	return buf
}

func TestUSBRegistryStringsBoundedDecode(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind uint32
		text string
		want []string
	}{
		{"short string", 1, "a\x00", []string{"a"}},
		{"empty string", 1, "\x00", []string{""}},
		{"unicode identity", 1, "طابعة 🖨\x00", []string{"طابعة 🖨"}},
		{"hardware IDs", 7, "USB\\VID_1234&PID_ABCD\x00USB\\Class_07\x00\x00", []string{"USB\\VID_1234&PID_ABCD", "USB\\Class_07"}},
		{"empty multi-string", 7, "\x00\x00", nil},
		{"padding after terminator", 7, "first\x00\x00padding\x00", []string{"first"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := decodeUSBRegistryStrings(registryUTF16(tc.text), tc.kind)
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("decode = %#v, %v; want %#v", got, err, tc.want)
			}
		})
	}
}

func TestUSBRegistryStringsRejectMalformed(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind uint32
		buf  []byte
	}{
		{"empty buffer", 1, nil},
		{"odd byte length", 1, []byte{0}},
		{"unterminated string", 1, registryUTF16("printer")},
		{"unterminated list", 7, registryUTF16("first\x00second")},
		{"missing list terminator", 7, registryUTF16("first\x00")},
		{"unsupported type", 3, []byte{0, 0}},
		{"oversize property", 1, make([]byte, 8194)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := decodeUSBRegistryStrings(tc.buf, tc.kind); err == nil {
				t.Fatalf("malformed identity accepted: %#v", got)
			}
		})
	}
}
