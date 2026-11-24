// Package payload implements the strict print-job payload contract shared
// between the Cloud Print Gateway and the Windows agent.
package payload

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"regexp"
)

type Type string

const (
	TypeRaw    Type = "raw"
	TypeESCPOS Type = "escpos"
	TypePDF    Type = "pdf"
	TypeImage  Type = "image"
)

const EncodingBase64 = "base64"
const MaxPayloadBytes = 5 * 1024 * 1024

var geometryFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Peripherals struct {
	Drawer string
	Cutter string
	Buzzer string
}

type Payload struct {
	GeometryFingerprint string
	Type                Type
	Protocol            string
	Data                []byte
	Peripherals         Peripherals
}

func requiredStringField(m map[string]interface{}, key string) (string, error) {
	raw, ok := m[key]
	if !ok || raw == nil {
		return "", fmt.Errorf("payload.%s is required", key)
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("payload.%s must be a string", key)
	}
	return value, nil
}

func optionalStringField(m map[string]interface{}, key string) (string, error) {
	raw, present := m[key]
	if !present {
		return "", nil
	}
	// Zod's optional string/enum fields permit an absent property, never
	// explicit JSON null. Keeping that distinction prevents a differently
	// serialized payload from bypassing Gateway admission in the Agent.
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("payload.%s must be a string when present", key)
	}
	return value, nil
}

func Parse(raw interface{}) (*Payload, error) {
	if raw == nil {
		return nil, fmt.Errorf("payload is missing")
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("payload must be a JSON object")
	}

	typ, err := requiredStringField(m, "type")
	if err != nil {
		return nil, err
	}
	switch Type(typ) {
	case TypeRaw, TypeESCPOS, TypePDF, TypeImage:
	default:
		if typ == "" {
			return nil, fmt.Errorf("payload.type is required")
		}
		return nil, fmt.Errorf("unsupported payload type %q (expected %q, %q, %q or %q)", typ, TypeRaw, TypeESCPOS, TypePDF, TypeImage)
	}

	protocol, err := optionalStringField(m, "protocol")
	if err != nil {
		return nil, err
	}

	switch Type(typ) {
	case TypeRaw:
		if protocol == "" {
			return nil, fmt.Errorf("protocol is required for raw payloads")
		}
		switch protocol {
		case "raw", "escpos", "zpl", "tspl":
		default:
			return nil, fmt.Errorf("unsupported protocol %q for raw payload", protocol)
		}
	case TypeESCPOS:
		if protocol == "" {
			return nil, fmt.Errorf("protocol is required for escpos payloads")
		}
		if protocol != "escpos" {
			return nil, fmt.Errorf("protocol %q is incompatible with escpos payload", protocol)
		}
	case TypePDF, TypeImage:
		// Gateway's optional protocol enum admits absence, not an explicitly
		// supplied empty string. Neither PDF nor image may declare a protocol.
		if _, present := m["protocol"]; present {
			return nil, fmt.Errorf("protocol is not applicable for %s payloads", typ)
		}
	}

	geometryFingerprint, err := optionalStringField(m, "geometry_fingerprint")
	if err != nil {
		return nil, err
	}
	_, geometryPresent := m["geometry_fingerprint"]
	if Type(typ) == TypeImage && geometryPresent && !geometryFingerprintPattern.MatchString(geometryFingerprint) {
		return nil, fmt.Errorf("image payload.geometry_fingerprint must identify the current measured printer geometry")
	}
	if Type(typ) != TypeImage && geometryPresent {
		return nil, fmt.Errorf("geometry_fingerprint is only applicable to image payloads")
	}

	encoding, err := requiredStringField(m, "encoding")
	if err != nil {
		return nil, err
	}
	if encoding != EncodingBase64 {
		return nil, fmt.Errorf("unsupported payload encoding %q (only %q is supported)", encoding, EncodingBase64)
	}
	dataStr, err := requiredStringField(m, "data")
	if err != nil {
		return nil, err
	}
	if dataStr == "" {
		return nil, fmt.Errorf("payload.data is required")
	}
	if len(dataStr) > (MaxPayloadBytes/3)*4+8 {
		return nil, fmt.Errorf("payload too large (exceeds %d byte limit)", MaxPayloadBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, fmt.Errorf("payload.data is not valid base64: %w", err)
	}
	if len(decoded) == 0 || len(decoded) > MaxPayloadBytes {
		return nil, fmt.Errorf("payload exceeds %d byte limit", MaxPayloadBytes)
	}
	// The Gateway rejects even decodable noncanonical wire spellings. The
	// standard Go decoder accepts CR/LF and alternate padding bits; without
	// a round-trip check, the Agent could execute a byte-identical payload
	// under a different serialized identity. Never dispatch that payload.
	if base64.StdEncoding.EncodeToString(decoded) != dataStr {
		return nil, fmt.Errorf("payload.data must use canonical padded base64")
	}

	// PDF identity is strict and shared with the Gateway and execution layer:
	// the signature must begin at byte zero. This also avoids rejecting a RAW
	// printer stream merely because it contains the marker later as text.
	looksLikePDF := bytes.HasPrefix(decoded, []byte("%PDF-"))
	looksLikeJPEG := len(decoded) >= 3 && decoded[0] == 0xff && decoded[1] == 0xd8 && decoded[2] == 0xff
	if Type(typ) == TypePDF && !looksLikePDF {
		return nil, fmt.Errorf("PDF payload must start with the %%PDF- signature")
	}
	if Type(typ) == TypePDF {
		// Mirror the Gateway's syntax admission: native driver validation is
		// a later boundary, never a substitute for an incomplete PDF refusal.
		tailStart := len(decoded) - 4096
		if tailStart < 0 {
			tailStart = 0
		}
		if !bytes.Contains(decoded[tailStart:], []byte("%%EOF")) {
			return nil, fmt.Errorf("PDF payload is incomplete (missing %%%%EOF trailer)")
		}
	}
	if Type(typ) == TypeImage && !looksLikeJPEG {
		return nil, fmt.Errorf("image payload must be a JPEG")
	}
	if (Type(typ) == TypeRaw || Type(typ) == TypeESCPOS) && looksLikePDF {
		return nil, fmt.Errorf("PDF bytes cannot be labeled as raw/escpos")
	}

	if value, present := m["peripherals"]; present {
		peripherals, ok := value.(map[string]interface{})
		if !ok || peripherals == nil {
			return nil, fmt.Errorf("payload.peripherals must be an object")
		}
	}
	var periph Peripherals
	if periphMap, ok := m["peripherals"].(map[string]interface{}); ok {
		// A present-but-non-string peripheral is a contract violation, not
		// an absent one: the Gateway's z.enum rejects it, so silently
		// ignoring it here would print without the requested device action.
		for _, key := range []string{"drawer", "cutter", "buzzer"} {
			if v, present := periphMap[key]; present {
				if _, ok := v.(string); !ok {
					return nil, fmt.Errorf("invalid %s mode type %T; expected string", key, v)
				}
			}
		}
		// Unknown peripheral keys are rejected, not dropped: a "cuttter"
		// typo must fail loudly instead of printing without the cut.
		// (The Gateway's strict schema already rejects these at admission;
		// this is the defense-in-depth mirror for the same wire contract.)
		for key := range periphMap {
			if key != "drawer" && key != "cutter" && key != "buzzer" {
				return nil, fmt.Errorf("unknown peripherals field %q; expected drawer, cutter, buzzer", key)
			}
		}
		if d, ok := periphMap["drawer"].(string); ok {
			switch d {
			case "pin2", "pin5", "none":
				periph.Drawer = d
			default:
				return nil, fmt.Errorf("invalid drawer mode %q", d)
			}
		}
		if c, ok := periphMap["cutter"].(string); ok {
			switch c {
			case "partial", "full", "none":
				periph.Cutter = c
			default:
				return nil, fmt.Errorf("invalid cutter mode %q", c)
			}
		}
		if b, ok := periphMap["buzzer"].(string); ok {
			switch b {
			case "epson_pulse", "star_bel", "none":
				periph.Buzzer = b
			default:
				return nil, fmt.Errorf("invalid buzzer mode %q", b)
			}
		}
	}

	// "none" is an INACTIVE setting, not an action: it must never count as
	// a configured peripheral (serializing inactive peripherals as active
	// semantic values would make e.g. {drawer:"none"} a zpl payload killer).
	active := func(v string) bool { return v != "" && v != "none" }
	hasPeripherals := active(periph.Drawer) || active(periph.Cutter) || active(periph.Buzzer)
	if hasPeripherals && protocol != "escpos" && Type(typ) != TypeImage {
		return nil, fmt.Errorf("peripherals are only supported for escpos protocol")
	}
	if !hasPeripherals {
		periph = Peripherals{}
	}

	return &Payload{
		GeometryFingerprint: geometryFingerprint,
		Type:                Type(typ),
		Protocol:            protocol,
		Data:                decoded,
		Peripherals:         periph,
	}, nil
}
