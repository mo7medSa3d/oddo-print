package printer

import (
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/text/language"
)

const maxIPPPrintResponseBytes = 1 << 20

type ippJobEvidence struct {
	ID    int32
	State int32
}

// parseIPPPrintJobEvidence checks the successful Print-Job response contract
// in RFC 8011 section 4.2.1.2 and the framing in RFC 8010 section 3.2. It must
// retain groups and types: the discovery attribute map intentionally flattens
// them and is not evidence that a submitted document created a usable Job.
//
// This is submission evidence only. The returned URI is validated as an
// identifier and is never followed; no response proves physical paper output.
func parseIPPPrintJobEvidence(data []byte, requestID uint32) (ippJobEvidence, error) {
	return parseIPPPrintResponse(data, requestID, true)
}

// validateIPPPrintResponseEnvelope is required before treating an IPP client
// error as a definite refusal after transmission. Errors do not need returned
// Job attributes, but still need correlation and the typed operation envelope.
func validateIPPPrintResponseEnvelope(data []byte, requestID uint32) error {
	_, err := parseIPPPrintResponse(data, requestID, false)
	return err
}

func parseIPPPrintResponse(data []byte, requestID uint32, requireJob bool) (ippJobEvidence, error) {
	var job ippJobEvidence
	if len(data) < 9 || len(data) > maxIPPPrintResponseBytes {
		return job, fmt.Errorf("invalid response size")
	}
	// Minor versions add compatible features. Accept nonnegative minor
	// versions for the two supported major versions, rather than a whitelist
	// which would reject future compatible responses.
	if (data[0] != 1 && data[0] != 2) || data[1] > 127 {
		return job, fmt.Errorf("unsupported response version")
	}
	if requestID == 0 || requestID > 0x7fffffff || binary.BigEndian.Uint32(data[4:8]) != requestID {
		return job, fmt.Errorf("response request-id does not match submission")
	}
	if requireJob && binary.BigEndian.Uint16(data[2:4]) > 0x00ff {
		return job, fmt.Errorf("response status is not successful")
	}

	var group byte
	currentName := ""
	operationValues := 0
	seenCharset, seenLanguage, seenJobGroup := false, false, false
	seenID, seenURI, seenState, seenReasons := false, false, false, false
	reasonCount, hasNone := 0, false
	for i := 8; i < len(data); {
		tag := data[i]
		i++
		if tag == 0x03 {
			if i != len(data) {
				return job, fmt.Errorf("trailing data after response end tag")
			}
			if !seenCharset || !seenLanguage {
				return job, fmt.Errorf("missing required operation attributes")
			}
			if !requireJob {
				return job, nil
			}
			if group != 0x02 || !seenJobGroup || !seenID || !seenURI || !seenState || !seenReasons {
				return job, fmt.Errorf("missing required Job attributes")
			}
			if hasNone && reasonCount != 1 {
				return job, fmt.Errorf("job-state-reasons combines none with other values")
			}
			if job.State == 7 || job.State == 8 {
				return job, fmt.Errorf("returned Job is canceled or aborted (state %d)", job.State)
			}
			return job, nil
		}
		if tag <= 0x0f {
			switch tag {
			case 0x01: // Operation Attributes must be the first, unique group.
				if group != 0 {
					return job, fmt.Errorf("repeated or misplaced operation group")
				}
			case 0x05: // Optional Unsupported Attributes precede Job Attributes.
				if group != 0x01 || !seenCharset || !seenLanguage {
					return job, fmt.Errorf("misplaced unsupported group")
				}
			case 0x02:
				if (group != 0x01 && group != 0x05) || !seenCharset || !seenLanguage || seenJobGroup {
					return job, fmt.Errorf("repeated or misplaced Job group")
				}
				seenJobGroup = true
			default:
				return job, fmt.Errorf("unexpected Print-Job response group")
			}
			group, currentName = tag, ""
			continue
		}
		if group == 0 || i+2 > len(data) {
			return job, fmt.Errorf("attribute outside a group or truncated name length")
		}
		nameLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		// Attribute names have keyword syntax and a 255-octet limit. This
		// also rejects negative SIGNED-SHORT name lengths.
		if nameLen > 255 || nameLen > len(data)-i {
			return job, fmt.Errorf("invalid attribute name length")
		}
		named := nameLen != 0
		if named {
			name := data[i : i+nameLen]
			if !validIPPKeyword(name) {
				return job, fmt.Errorf("invalid attribute name syntax")
			}
			currentName = string(name)
		} else if currentName == "" {
			return job, fmt.Errorf("additional value has no attribute in its group")
		}
		i += nameLen
		if i+2 > len(data) {
			return job, fmt.Errorf("truncated attribute value length")
		}
		valueLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if valueLen > 32767 || valueLen > len(data)-i {
			return job, fmt.Errorf("negative or truncated attribute value length")
		}
		value := data[i : i+valueLen]
		i += valueLen

		if group == 0x01 {
			if operationValues < 2 {
				want := "attributes-charset"
				if operationValues == 1 {
					want = "attributes-natural-language"
				}
				if !named || currentName != want {
					return job, fmt.Errorf("required operation attributes are not first and ordered")
				}
			}
			operationValues++
			switch currentName {
			case "attributes-charset":
				if !named || seenCharset || tag != 0x47 || string(value) != "utf-8" {
					return job, fmt.Errorf("invalid or duplicate response charset")
				}
				seenCharset = true
			case "attributes-natural-language":
				if !named || seenLanguage || tag != 0x48 || !validIPPNaturalLanguage(value) {
					return job, fmt.Errorf("invalid or duplicate response natural language")
				}
				seenLanguage = true
			}
			continue
		}
		if group != 0x02 || !requireJob {
			continue // Unsupported Attributes cannot satisfy Job evidence.
		}
		switch currentName {
		case "job-id":
			if !named || seenID || tag != 0x21 || len(value) != 4 {
				return job, fmt.Errorf("invalid or duplicate job-id")
			}
			job.ID = int32(binary.BigEndian.Uint32(value))
			if job.ID <= 0 {
				return job, fmt.Errorf("job-id must be a positive integer")
			}
			seenID = true
		case "job-uri":
			if !named || seenURI || tag != 0x45 || !validIPPJobURI(value) {
				return job, fmt.Errorf("invalid or duplicate job-uri")
			}
			seenURI = true
		case "job-state":
			if !named || seenState || tag != 0x23 || len(value) != 4 {
				return job, fmt.Errorf("invalid or duplicate job-state")
			}
			job.State = int32(binary.BigEndian.Uint32(value))
			if job.State < 3 || job.State > 9 {
				return job, fmt.Errorf("unsupported job-state")
			}
			seenState = true
		case "job-state-reasons":
			if (named && seenReasons) || tag != 0x44 || !validIPPKeyword(value) {
				return job, fmt.Errorf("invalid or duplicate job-state-reasons")
			}
			seenReasons = true
			reasonCount++
			hasNone = hasNone || string(value) == "none"
		}
	}
	return job, fmt.Errorf("missing response end tag")
}

func validIPPKeyword(value []byte) bool {
	if len(value) == 0 || len(value) > 255 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, c := range value {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '.' && c != '_' {
			return false
		}
	}
	return true
}

func validIPPNaturalLanguage(value []byte) bool {
	if len(value) == 0 || len(value) > 63 {
		return false
	}
	partLength := 0
	for _, c := range value {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
		if c == '-' {
			if partLength == 0 {
				return false
			}
			partLength = 0
		} else {
			partLength++
			if partLength > 8 {
				return false
			}
		}
	}
	if partLength == 0 {
		return false
	}
	_, err := language.Parse(string(value))
	if err == nil {
		return true
	}
	// A well-formed tag with a newly registered/unknown subtag remains valid
	// syntax. Do not make printer acceptance depend on our registry snapshot.
	_, wellFormed := err.(language.ValueError)
	return wellFormed
}

func validIPPJobURI(value []byte) bool {
	if len(value) == 0 || len(value) > 1023 {
		return false
	}
	// net/url accepts spaces and some non-URI characters in paths. Check
	// RFC 3986's ASCII URI alphabet before parsing its structure/escapes.
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == '%' {
			if i+2 >= len(value) || !ippURIHexDigit(value[i+1]) || !ippURIHexDigit(value[i+2]) {
				return false
			}
			i += 2
			continue
		}
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("-._~:/?#[]@!$&'()*+,;=", rune(c)) {
			continue
		}
		return false
	}
	u, err := url.Parse(string(value))
	if err != nil || !u.IsAbs() {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "ipp", "ipps", "http", "https":
		return u.Opaque == "" && u.Hostname() != ""
	default:
		return u.Opaque != "" || u.Host != "" || u.Path != ""
	}
}

func ippURIHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
