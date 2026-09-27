package config

import "path/filepath"

// RegistryPath returns the persistent printer registry path associated with
// the agent configuration file. Keep this helper in the config package because
// callers use it as the storage-path contract for discovered/manual printers.
func RegistryPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	return filepath.Join(dir, "printers.json")
}

// QueueDBPath returns the local durable print-queue database path associated
// with the agent configuration file. Like RegistryPath, a bare filename
// resolves against the executable directory so the registry and the queue
// never split across directories.
func QueueDBPath(configPath string) string {
	dir := filepath.Dir(configPath)
	if dir == "" || dir == "." {
		if d, err := ExecutableDir(); err == nil {
			dir = d
		}
	}
	return filepath.Join(dir, "queue.db")
}
