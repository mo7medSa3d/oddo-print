package printer

import (
	"encoding/binary"
	"fmt"
	"mime"
	"strings"
)

const maxIPPAttributesBytes = 64 * 1024

// Capability and health evidence must retain RFC 8010 groups and value types;
// the permissive diagnostic attribute map is not printer authorization.
func parseIPPPrinterAttributes(data []byte, requestID uint32) (map[string]string, error) {
	if len(data) < 9 || len(data) > maxIPPAttributesBytes {
		return nil, fmt.Errorf("invalid IPP attributes response size")
	}
	if (data[0] != 1 && data[0] != 2) || data[1] > 127 {
		return nil, fmt.Errorf("unsupported IPP attributes response version")
	}
	if requestID == 0 || requestID > 0x7fffffff || binary.BigEndian.Uint32(data[4:8]) != requestID {
		return nil, fmt.Errorf("IPP attributes response request-id mismatch")
	}
	if status := binary.BigEndian.Uint16(data[2:4]); status > 0x00ff {
		return nil, fmt.Errorf("IPP status 0x%04x: %w", status, errIPPStatusUnsupported)
	}
	out := make(map[string]string)
	var group, currentTag byte
	currentName := ""
	operationValues, collectionDepth := 0, 0
	seen := make(map[string]bool)
	for i := 8; i < len(data); {
		tag := data[i]
		i++
		if tag <= 0x0f {
			if collectionDepth != 0 {
				return nil, fmt.Errorf("unfinished IPP collection")
			}
			if tag == 0x03 {
				if i != len(data) || operationValues < 2 {
					return nil, fmt.Errorf("incomplete IPP operation envelope or trailing response data")
				}
				if reasons := out["printer-state-reasons"]; reasons != "none" && strings.Contains(","+reasons+",", ",none,") {
					return nil, fmt.Errorf("IPP printer-state-reasons combines none with other values")
				}
				return out, nil
			}
			switch tag {
			case 0x01:
				if group != 0 {
					return nil, fmt.Errorf("repeated or misplaced IPP operation group")
				}
			case 0x05:
				if group != 0x01 || operationValues < 2 {
					return nil, fmt.Errorf("misplaced IPP unsupported group")
				}
			case 0x04:
				if (group != 0x01 && group != 0x05) || operationValues < 2 {
					return nil, fmt.Errorf("repeated or misplaced IPP printer group")
				}
			default:
				return nil, fmt.Errorf("unexpected IPP printer response group")
			}
			group, currentName = tag, ""
			seen = make(map[string]bool)
			continue
		}
		if group == 0 || i+2 > len(data) {
			return nil, fmt.Errorf("IPP attribute outside a group or truncated name length")
		}
		nameLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if nameLen > 255 || nameLen > len(data)-i {
			return nil, fmt.Errorf("invalid IPP attribute name length")
		}
		name := data[i : i+nameLen]
		i += nameLen
		if i+2 > len(data) {
			return nil, fmt.Errorf("truncated IPP attribute value length")
		}
		valueLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if valueLen > 32767 || valueLen > len(data)-i {
			return nil, fmt.Errorf("negative or truncated IPP attribute value length")
		}
		value := data[i : i+valueLen]
		i += valueLen
		if collectionDepth != 0 {
			if nameLen != 0 {
				return nil, fmt.Errorf("named IPP collection member value")
			}
			switch tag {
			case 0x34:
				if valueLen != 0 {
					return nil, fmt.Errorf("invalid IPP collection start")
				}
				collectionDepth++
			case 0x37:
				if valueLen != 0 {
					return nil, fmt.Errorf("invalid IPP collection end")
				}
				collectionDepth--
			case 0x4a:
				if !validIPPKeyword(value) {
					return nil, fmt.Errorf("invalid IPP collection member name")
				}
			}
			continue // Unrequested collection members cannot supply top-level capabilities.
		}
		named := nameLen != 0
		if named {
			if !validIPPKeyword(name) || seen[string(name)] {
				return nil, fmt.Errorf("invalid or duplicate IPP attribute name")
			}
			currentName, currentTag = string(name), tag
			seen[currentName] = true
		} else if currentName == "" {
			return nil, fmt.Errorf("IPP additional value has no attribute in its group")
		}
		if tag == 0x37 || tag == 0x4a {
			return nil, fmt.Errorf("IPP collection member outside a collection")
		}
		if group == 0x01 {
			if operationValues < 2 {
				want := "attributes-charset"
				if operationValues == 1 {
					want = "attributes-natural-language"
				}
				if !named || currentName != want {
					return nil, fmt.Errorf("required IPP operation attributes are not first and ordered")
				}
			}
			operationValues++
			switch currentName {
			case "attributes-charset":
				if !named || tag != 0x47 || string(value) != "utf-8" {
					return nil, fmt.Errorf("invalid IPP response charset")
				}
			case "attributes-natural-language":
				if !named || tag != 0x48 || !validIPPNaturalLanguage(value) {
					return nil, fmt.Errorf("invalid IPP response natural language")
				}
			}
		}
		if group == 0x04 {
			known, single := ippPrinterAttributeType(currentName)
			if known != 0 {
				if (!named && (single || tag != currentTag)) || ((tag == 0x10 || tag == 0x12 || tag == 0x13) && valueLen != 0) {
					return nil, fmt.Errorf("invalid IPP additional or unavailable value for %s", currentName)
				}
				if tag == 0x10 || tag == 0x12 || tag == 0x13 {
					out[currentName] = ""
					continue // Security-filtered or unknown capabilities are not permission.
				}
				decoded, err := decodeIPPPrinterAttribute(currentName, tag, known, value)
				if err != nil {
					return nil, err
				}
				if decoded == "" {
					continue
				}
				if existing := out[currentName]; existing != "" {
					out[currentName] = existing + "," + decoded
				} else {
					out[currentName] = decoded
				}
			}
		}
		if tag == 0x34 {
			if valueLen != 0 {
				return nil, fmt.Errorf("invalid IPP collection start")
			}
			collectionDepth = 1
		}
	}
	return nil, fmt.Errorf("missing IPP response end tag")
}

func ippPrinterAttributeType(name string) (tag byte, single bool) {
	switch name {
	case "printer-state":
		return 0x23, true
	case "printer-is-accepting-jobs":
		return 0x22, true
	case "document-format-default":
		return 0x49, true
	case "document-format-supported":
		return 0x49, false
	case "printer-state-reasons", "pwg-raster-document-type-supported":
		return 0x44, false
	case "pwg-raster-document-resolution-supported":
		return 0x32, false
	default:
		return 0, false
	}
}

func decodeIPPPrinterAttribute(name string, tag, want byte, value []byte) (string, error) {
	invalid := func() (string, error) { return "", fmt.Errorf("invalid IPP printer attribute %s", name) }
	if tag != want {
		return invalid()
	}
	switch tag {
	case 0x23:
		if len(value) != 4 {
			return invalid()
		}
		if state := binary.BigEndian.Uint32(value); state < 3 || state > 5 {
			return invalid()
		}
	case 0x22:
		if len(value) != 1 || value[0] > 1 {
			return invalid()
		}
	case 0x44:
		if !validIPPKeyword(value) {
			return invalid()
		}
	case 0x49:
		if len(value) == 0 || len(value) > 255 {
			return invalid()
		}
		for _, c := range value {
			if c < 0x20 || c > 0x7e {
				return invalid()
			}
		}
		mediaType, _, err := mime.ParseMediaType(string(value))
		if err != nil || !strings.ContainsRune(mediaType, '/') {
			return invalid()
		}
		// shortcut: CSV capability values cannot encode comma-bearing MIME parameters; keep those formats unavailable until values retain their types.
		if strings.ContainsRune(string(value), ',') {
			return "", nil
		}
	case 0x32:
		if len(value) != 9 {
			return invalid()
		}
		x, y := int32(binary.BigEndian.Uint32(value[:4])), int32(binary.BigEndian.Uint32(value[4:8]))
		if x <= 0 || y <= 0 || (value[8] != 3 && value[8] != 4) {
			return invalid()
		}
		unit := "dpi"
		if value[8] == 4 {
			unit = "dpcm"
		}
		return fmt.Sprintf("%dx%d%s", x, y, unit), nil
	}
	return decodeIPPValue(tag, value), nil
}
