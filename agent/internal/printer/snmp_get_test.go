package printer

import (
	"bytes"
	"testing"
)

func TestBuildSNMPGetEncodesVarBindLengthsFromOID(t *testing.T) {
	oids := []string{
		"1.3.6.1.2.1.1.1.0",
		"1.3.6.1.2.1.1.5.0",
	}
	packet := buildSNMPGet(oids)
	for _, oid := range oids {
		oidBytes := encodeOID(oid)
		needle := append([]byte{0x30, byte(2 + len(oidBytes) + 2), 0x06, byte(len(oidBytes))}, oidBytes...)
		needle = append(needle, 0x05, 0x00)
		if !bytes.Contains(packet, needle) {
			t.Fatalf("SNMP GET does not contain correctly sized VarBind for OID %s: %x", oid, needle)
		}
	}
}
