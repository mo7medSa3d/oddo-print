package printer

import "testing"

func TestParseUserConnectionKeyName(t *testing.T) {
	cases := []struct {
		raw        string
		wantServer string
		wantQueue  string
		wantOK     bool
	}{
		{",,PRINTSRV,HP LaserJet Pro M404", "PRINTSRV", "HP LaserJet Pro M404", true},
		{",,print-server,Epson TM-T20", "print-server", "Epson TM-T20", true},
		{",,SRV,Queue, With Comma", "SRV", "Queue,With Comma", true},
		{"", "", "", false},
		{",,ONLYONE", "", "", false},
	}
	for _, tc := range cases {
		server, queue, ok := parseUserConnectionKeyName(tc.raw)
		if ok != tc.wantOK || server != tc.wantServer || queue != tc.wantQueue {
			t.Errorf("%q: want %q/%q/%v got %q/%q/%v", tc.raw, tc.wantServer, tc.wantQueue, tc.wantOK, server, queue, ok)
		}
	}
}

func TestIsUserProfileSID(t *testing.T) {
	for _, sid := range []string{"S-1-5-21-1004336348-1177238915-682003330-1001", "S-1-12-1-1234567890-1234567890-1234567890-1234567890"} {
		if !isUserProfileSID(sid) {
			t.Errorf("%q should be a user profile SID", sid)
		}
	}
	for _, key := range []string{".DEFAULT", "S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-21-1004336348-1177238915-682003330-1001_Classes"} {
		if isUserProfileSID(key) {
			t.Errorf("%q should NOT be a user profile SID", key)
		}
	}
}

func TestUnseenUserConnections(t *testing.T) {
	conns := []userPrinterConnection{
		{UserSID: "S-1-5-21-1-2-3-1001", Server: "SRV", Queue: "HP LaserJet Pro M404"},
		{UserSID: "S-1-5-21-1-2-3-1001", Server: "SRV", Queue: "Epson TM-T20"},
		{UserSID: "S-1-5-21-1-2-3-1002", Server: "SRV", Queue: "Shared Label"},
	}
	infos := []DeviceInfo{
		{Name: "hp laserjet pro m404", SpoolerName: "HP LaserJet Pro M404"},
		{Name: "Some Queue", SpoolerShare: "Shared Label"},
	}
	unseen := unseenUserConnections(conns, infos)
	if len(unseen) != 1 || unseen[0].Queue != "Epson TM-T20" {
		t.Fatalf("want only the Epson connection unseen, got %+v", unseen)
	}
}
