package printer

// Both physical hardware printers and printable virtual printers (such as
// Microsoft Print to PDF, Microsoft XPS Document Writer, CUPS-PDF, Print to
// File, and Save as PDF) are first-class managed printers. Only redirected,
// fax, and blackhole/null stubs are excluded.
func IsManagedPrinter(d DeviceInfo) bool {
	return IsProductionPrinter(d)
}
