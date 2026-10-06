//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Reconfigure a stopped service during upgrades without deleting its account,
// identity or permissions. Updating a running service would falsely report that
// the new executable is active while the old process is still printing.
func updateInstalledService(wanted *service.Config) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	existing, err := manager.OpenService(wanted.Name)
	if err != nil {
		return err
	}
	defer existing.Close()
	status, err := existing.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Stopped {
		return fmt.Errorf("%s must be stopped before upgrading", wanted.Name)
	}
	current, err := existing.Config()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	current.BinaryPathName = windows.EscapeArg(executable)
	for _, argument := range wanted.Arguments {
		current.BinaryPathName += " " + windows.EscapeArg(argument)
	}
	current.DisplayName = wanted.DisplayName
	current.Description = wanted.Description
	current.Dependencies = wanted.Dependencies
	current.StartType = mgr.StartAutomatic
	// nil account/password pointers mean preserve the existing service account.
	current.ServiceStartName = ""
	current.Password = ""
	return existing.UpdateConfig(current)
}

func purgeLegacyAgentServices() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Windows Service Control Manager: %w", err)
	}
	defer manager.Disconnect()

	for _, name := range []string{"YasserAgent", "OdooPrintAgent"} {
		existing, err := manager.OpenService(name)
		if err != nil {
			if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
				continue
			}
			return fmt.Errorf("open legacy service %s: %w", name, err)
		}

		status, queryErr := existing.Query()
		if queryErr == nil && status.State != svc.Stopped {
			if _, stopErr := existing.Control(svc.Stop); stopErr != nil &&
				!errors.Is(stopErr, windows.ERROR_SERVICE_NOT_ACTIVE) {
				existing.Close()
				return fmt.Errorf("stop legacy service %s: %w", name, stopErr)
			}
			deadline := time.Now().Add(30 * time.Second)
			for {
				status, queryErr = existing.Query()
				if queryErr != nil || status.State == svc.Stopped {
					break
				}
				if time.Now().After(deadline) {
					existing.Close()
					return fmt.Errorf("timed out waiting for legacy service %s to stop", name)
				}
				time.Sleep(250 * time.Millisecond)
			}
		}
		deleteErr := existing.Delete()
		_ = existing.Close()
		if deleteErr != nil &&
			!errors.Is(deleteErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) &&
			!errors.Is(deleteErr, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return fmt.Errorf("delete legacy service %s: %w", name, deleteErr)
		}
	}
	return nil
}

func purgeRunValues(root registry.Key, path string) {
	key, err := registry.OpenKey(root, path, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	for _, value := range []string{
		"Yaseir Print Manager",
		"Yasser Print Manager",
		"YaseirManager",
		"YasserManager",
		"OdooPrintManager",
		"Odoo Print Manager",
		"com.yasser.manager",
	} {
		_ = key.DeleteValue(value)
	}
}

func purgeAutostartRegistry() {
	const runPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	purgeRunValues(registry.CURRENT_USER, runPath)

	users, err := registry.OpenKey(registry.USERS, "", registry.READ)
	if err != nil {
		return
	}
	defer users.Close()
	sids, err := users.ReadSubKeyNames(-1)
	if err != nil {
		return
	}
	for _, sid := range sids {
		purgeRunValues(registry.USERS, sid+`\`+runPath)
	}
}

func purgePaths(roots []string) error {
	var failures []string
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		root = filepath.Clean(strings.TrimSpace(root))
		if root == "." || root == "" {
			continue
		}
		key := strings.ToLower(root)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		if err := os.RemoveAll(root); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", root, err))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("purge Yaseir data: %s", strings.Join(failures, "; "))
	}
	return nil
}

func agentDataRoots() []string {
	var roots []string
	if programData := strings.TrimSpace(os.Getenv("PROGRAMDATA")); programData != "" {
		for _, name := range []string{"YaseirAgent", "YasserAgent", "OdooPrintAgent"} {
			roots = append(roots, filepath.Join(programData, name))
		}
	}
	return roots
}

func managerDataRoots() []string {
	var roots []string
	if programData := strings.TrimSpace(os.Getenv("PROGRAMDATA")); programData != "" {
		for _, name := range []string{"YaseirManager", "YasserManager", "OdooPrintManager"} {
			roots = append(roots, filepath.Join(programData, name))
		}
	}

	userDataNames := []string{
		"YaseirManager",
		"YasserManager",
		"Yaseir Print Manager",
		"Yasser Print Manager",
		"OdooPrintManager",
		"Odoo Print Manager",
		"com.yasser.manager",
	}
	for _, envName := range []string{"LOCALAPPDATA", "APPDATA"} {
		if root := strings.TrimSpace(os.Getenv(envName)); root != "" {
			for _, name := range userDataNames {
				roots = append(roots, filepath.Join(root, name))
			}
		}
	}

	// MSI deferred custom actions run as LocalSystem, whose LOCALAPPDATA is not
	// the interactive user's profile. Enumerate only fixed product subpaths
	// beneath each local profile so no unrelated user data can be removed.
	if systemDrive := strings.TrimSpace(os.Getenv("SystemDrive")); systemDrive != "" {
		usersRoot := filepath.Join(systemDrive+string(os.PathSeparator), "Users")
		if entries, err := os.ReadDir(usersRoot); err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				profile := filepath.Join(usersRoot, entry.Name())
				for _, base := range []string{
					filepath.Join(profile, "AppData", "Local"),
					filepath.Join(profile, "AppData", "Roaming"),
				} {
					for _, name := range userDataNames {
						roots = append(roots, filepath.Join(base, name))
					}
				}
			}
		}
	}
	return roots
}

func purgeAgentData() error {
	return purgePaths(agentDataRoots())
}

func purgeInstallationData() error {
	roots := append(agentDataRoots(), managerDataRoots()...)
	if err := purgePaths(roots); err != nil {
		return err
	}
	purgeAutostartRegistry()
	return nil
}
