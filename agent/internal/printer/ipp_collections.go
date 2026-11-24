package printer

import (
	"encoding/binary"
	"fmt"
)

// Only the bounded, typed members of a requested collection may establish
// media capabilities. A nested name never becomes a top-level attribute.
type ippCollectionValue struct {
	tag        byte
	raw        []byte
	collection ippCollection
}
type ippCollection map[string][]ippCollectionValue

func readIPPCollection(data []byte, offset *int, depth int) (ippCollection, error) {
	if depth > 8 {
		return nil, fmt.Errorf("IPP collection nesting exceeds limit")
	}
	out := make(ippCollection)
	name := ""
	for *offset < len(data) {
		i := *offset
		if len(data)-i < 5 {
			return nil, fmt.Errorf("truncated IPP collection")
		}
		tag := data[i]
		if tag <= 0x0f || binary.BigEndian.Uint16(data[i+1:i+3]) != 0 {
			return nil, fmt.Errorf("invalid named IPP collection member")
		}
		n := int(binary.BigEndian.Uint16(data[i+3 : i+5]))
		i += 5
		if n > 32767 || n > len(data)-i {
			return nil, fmt.Errorf("truncated IPP collection value")
		}
		value := data[i : i+n]
		*offset = i + n
		switch tag {
		case 0x37:
			if n != 0 || (name != "" && len(out[name]) == 0) {
				return nil, fmt.Errorf("invalid IPP collection end")
			}
			return out, nil
		case 0x4a:
			if !validIPPKeyword(value) || (name != "" && len(out[name]) == 0) {
				return nil, fmt.Errorf("invalid IPP member name")
			}
			name = string(value)
			if _, exists := out[name]; exists || len(out) >= 64 {
				return nil, fmt.Errorf("duplicate or excessive IPP collection member")
			}
			out[name] = nil
		default:
			if name == "" || len(out[name]) >= 16 {
				return nil, fmt.Errorf("orphan or excessive IPP collection value")
			}
			v := ippCollectionValue{tag: tag, raw: value}
			if tag == 0x34 {
				if n != 0 {
					return nil, fmt.Errorf("invalid IPP nested collection start")
				}
				var err error
				v.collection, err = readIPPCollection(data, offset, depth+1)
				if err != nil {
					return nil, err
				}
			}
			out[name] = append(out[name], v)
		}
	}
	return nil, fmt.Errorf("unfinished IPP collection")
}

type ippMediaDimension struct {
	Min int `json:"min"`
	Max int `json:"max"`
}
type ippMedia struct {
	Width      ippMediaDimension `json:"width"`
	Height     ippMediaDimension `json:"height"`
	Keyword    string            `json:"keyword,omitempty"`
	Source     string            `json:"source,omitempty"`
	Type       string            `json:"type,omitempty"`
	Left       *int              `json:"left,omitempty"`
	Right      *int              `json:"right,omitempty"`
	Top        *int              `json:"top,omitempty"`
	Bottom     *int              `json:"bottom,omitempty"`
	Collection bool              `json:"collection"`
}

func ippDimensionMember(c ippCollection, name string) (ippMediaDimension, error) {
	v := c[name]
	var d ippMediaDimension
	if len(v) != 1 {
		return d, fmt.Errorf("IPP media %s requires one dimension", name)
	}
	if v[0].tag == 0x21 && len(v[0].raw) == 4 {
		d.Min = int(int32(binary.BigEndian.Uint32(v[0].raw)))
		d.Max = d.Min
	} else if v[0].tag == 0x33 && len(v[0].raw) == 8 {
		d.Min = int(int32(binary.BigEndian.Uint32(v[0].raw[:4])))
		d.Max = int(int32(binary.BigEndian.Uint32(v[0].raw[4:])))
	} else {
		return d, fmt.Errorf("invalid IPP media %s type", name)
	}
	// Hundredths of a millimetre, bounded before conversion or allocation.
	if d.Min <= 0 || d.Max < d.Min || d.Max > 1_000_000 {
		return d, fmt.Errorf("invalid IPP media %s bounds", name)
	}
	return d, nil
}

func ippMediaFromCollection(c ippCollection) (ippMedia, error) {
	m := ippMedia{Collection: true}
	size := c["media-size"]
	if len(size) != 1 || size[0].tag != 0x34 {
		return m, fmt.Errorf("IPP media collection lacks a typed media-size")
	}
	var err error
	m.Width, err = ippDimensionMember(size[0].collection, "x-dimension")
	if err != nil {
		return m, err
	}
	m.Height, err = ippDimensionMember(size[0].collection, "y-dimension")
	if err != nil {
		return m, err
	}
	for _, f := range []struct {
		name string
		dest **int
	}{{"media-left-margin", &m.Left}, {"media-right-margin", &m.Right}, {"media-top-margin", &m.Top}, {"media-bottom-margin", &m.Bottom}} {
		v, present := c[f.name]
		if !present {
			continue
		}
		if len(v) != 1 || v[0].tag != 0x21 || len(v[0].raw) != 4 {
			return m, fmt.Errorf("invalid IPP %s type", f.name)
		}
		n := int(int32(binary.BigEndian.Uint32(v[0].raw)))
		if n < 0 || n > 1_000_000 {
			return m, fmt.Errorf("invalid IPP %s bounds", f.name)
		}
		*f.dest = &n
	}
	for _, f := range []struct {
		name string
		dest *string
	}{{"media-size-name", &m.Keyword}, {"media-source", &m.Source}, {"media-type", &m.Type}} {
		v, present := c[f.name]
		if !present {
			continue
		}
		if len(v) != 1 || (v[0].tag != 0x44 && v[0].tag != 0x42) || !validIPPKeyword(v[0].raw) {
			return m, fmt.Errorf("invalid IPP %s value", f.name)
		}
		*f.dest = string(v[0].raw)
	}
	if m.Left != nil && m.Right != nil && *m.Left+*m.Right >= m.Width.Min {
		return m, fmt.Errorf("IPP horizontal margins consume media")
	}
	if m.Top != nil && m.Bottom != nil && *m.Top+*m.Bottom >= m.Height.Min {
		return m, fmt.Errorf("IPP vertical margins consume media")
	}
	return m, nil
}
