package printer

import (
	"encoding/binary"
	"fmt"
	"unicode/utf16"
)

// decodeUSBRegistryStrings decodes bounded REG_SZ and REG_MULTI_SZ data from
// SetupAPI. A short property allocation must never be reinterpreted as a fixed
// 8 KiB array. Missing terminators are incomplete identity evidence, not a
// trustworthy empty or truncated device identifier.
func decodeUSBRegistryStrings(buf []byte, dataType uint32) ([]string, error) {
	if len(buf) < 2 || len(buf)%2 != 0 || len(buf) > 8192 {
		return nil, fmt.Errorf("invalid USB registry string size %d", len(buf))
	}
	units := make([]uint16, len(buf)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(buf[2*i:])
	}
	switch dataType {
	case 1: // REG_SZ
		for i, unit := range units {
			if unit == 0 {
				return []string{string(utf16.Decode(units[:i]))}, nil
			}
		}
		return nil, fmt.Errorf("unterminated USB registry string")
	case 7: // REG_MULTI_SZ
		if len(units) < 2 {
			return nil, fmt.Errorf("unterminated USB registry string list")
		}
		var out []string
		start := 0
		for i := 0; i < len(units); i++ {
			if units[i] != 0 {
				continue
			}
			if i > start {
				out = append(out, string(utf16.Decode(units[start:i])))
			}
			if i+1 < len(units) && units[i+1] == 0 {
				return out, nil
			}
			start = i + 1
		}
		return nil, fmt.Errorf("unterminated USB registry string list")
	default:
		return nil, fmt.Errorf("unknown USB registry type %d", dataType)
	}
}
