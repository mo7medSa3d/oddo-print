package printer

import (
	"bytes"
	"testing"

	"github.com/gosnmp/gosnmp"
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

func TestSNMPDescriptionComesFromRequestedVarbind(t *testing.T) {
	for _, tc := range []struct{ name, oid, value, want string }{
		{"printer", oidSysDescr, "HP LaserJet printer", "HP LaserJet printer"},
		{"unicode", oidSysDescr, "طابعة إيصالات", "طابعة إيصالات"},
		{"wrong_oid", "1.3.6.1.2.1.1.5.0", "HP LaserJet printer", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			encoder := &gosnmp.GoSNMP{Version: gosnmp.Version1, Community: "public"}
			encoder.SetRequestID(0)
			packet, err := encoder.SnmpEncodePacket(gosnmp.GetResponse, []gosnmp.SnmpPDU{{Name: tc.oid, Type: gosnmp.OctetString, Value: []byte(tc.value)}}, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if got := extractSNMPString(packet); got != tc.want {
				t.Fatalf("description = %q, want %q", got, tc.want)
			}
			if got := extractSNMPString(packet[:len(packet)-1]); got != "" {
				t.Fatalf("accepted truncated response: %q", got)
			}
		})
	}
}
