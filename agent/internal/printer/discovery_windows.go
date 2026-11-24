//go:build windows

package printer

func enumSpoolerPrintersPlatform() ([]DeviceInfo, error) {
	return EnumSpoolerPrinters()
}
