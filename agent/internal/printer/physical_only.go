package printer

// Only hardware queues can be managed, discovered or persisted.
func IsManagedPrinter(d DeviceInfo) bool {
	return IsProductionPrinter(d)
}
