package printer

import "testing"

// Vendor fax queues are Windows software fax targets, not paper printers.
// An attached USB001 port is NOT sufficient evidence that a queue with a
// vendor-suffixed FAX driver will produce physical printed output.
func TestVendorFaxOnlyQueuesAreNeverPaperPrinters(t *testing.T) {
	for _, tc := range []struct {
		name, driver, port string
	}{
		{"Canon G4070 series FAX", "Canon G4070 series FAX", "USB001"},
		{"Canon G4070 series", "Canon G4070 series FAX", "USB001"},
		{"HP OfficeJet Pro FAX", "HP OfficeJet Pro FAX", "IP_192.168.1.70"},
	} {
		di := DeviceInfo{
			Name: tc.name, ConnectionType: "spooler", Protocol: "spooler",
			SpoolerName:  tc.name,
			Capabilities: map[string]interface{}{"port_name": tc.port, "driver_name": tc.driver},
		}
		if got := ClassifyDeviceInfo(di); got.Class != ClassVirtual {
			t.Errorf("%q (driver=%q): classification=%s; want virtual: %v", tc.name, tc.driver, got.Class, got.Reasons)
		}
		if IsProductionPrinter(di) {
			t.Errorf("%q was incorrectly offered for paper printing", tc.name)
		}
		if !isVirtualSpooler(tc.port, tc.driver, tc.name) {
			t.Errorf("%q is not excluded at Windows spooler discovery", tc.name)
		}
	}
}

func TestVendorMultifunctionActualPrinterStillSelectable(t *testing.T) {
	for _, tc := range []struct{ name, driver string }{
		{"Canon G4070 series", "Canon G4070 series Printer"},
		{"HP OfficeJet Pro 9010", "HP OfficeJet Pro 9010"},
		{"Office fax room laser printer", "HP Universal Printing PCL 6"},
	} {
		di := DeviceInfo{
			Name: tc.name, ConnectionType: "spooler", Protocol: "spooler",
			SpoolerName:  tc.name,
			Capabilities: map[string]interface{}{"port_name": "USB001", "driver_name": tc.driver},
		}
		if got := ClassifyDeviceInfo(di); got.Class != ClassPhysical {
			t.Errorf("%q normal printer unexpectedly blocked: class=%s reasons=%v", tc.name, got.Class, got.Reasons)
		}
	}
}
