//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func serviceCommandExecutable(binaryPath string) (string, error) {
	value := strings.TrimSpace(binaryPath)
	if value == "" {
		return "", fmt.Errorf("service binary path is empty")
	}
	if value[0] == '"' {
		end := strings.Index(value[1:], `"`)
		if end < 0 {
			return "", fmt.Errorf("service binary path has an unterminated quote")
		}
		executable := strings.TrimSpace(value[1 : 1+end])
		if executable == "" {
			return "", fmt.Errorf("service executable path is empty")
		}
		return executable, nil
	}
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return "", fmt.Errorf("service binary path is empty")
	}
	return fields[0], nil
}

func normalizeWindowsExecutablePath(path string) (string, error) {
	value := strings.TrimSpace(path)
	if strings.HasPrefix(strings.ToLower(value), `\\?\unc\`) {
		value = `\\` + value[len(`\\?\UNC\`):]
	} else if strings.HasPrefix(value, `\\?\`) {
		value = value[len(`\\?\`):]
	}
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("service executable path is not absolute: %q", value)
	}
	return filepath.Clean(value), nil
}

func serviceBinaryMatchesExact(binaryPath, expectedExecutable string) (bool, error) {
	actual, err := serviceCommandExecutable(binaryPath)
	if err != nil {
		return false, err
	}
	actual, err = normalizeWindowsExecutablePath(actual)
	if err != nil {
		return false, err
	}
	expected, err := normalizeWindowsExecutablePath(expectedExecutable)
	if err != nil {
		return false, err
	}
	return strings.EqualFold(actual, expected), nil
}

func currentAgentExecutable() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve current Agent executable: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return "", fmt.Errorf("resolve absolute Agent executable: %w", err)
	}
	return filepath.Clean(executable), nil
}

// verifyCurrentAgentServiceOwnershipIfPresent fails closed when the well-known
// service name exists but its configured binary is not this Agent executable.
// A service name alone is not sufficient ownership evidence.
func verifyCurrentAgentServiceOwnershipIfPresent() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to Windows Service Control Manager: %w", err)
	}
	defer manager.Disconnect()
	existing, err := manager.OpenService("YaseirAgent")
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		return fmt.Errorf("open YaseirAgent service for ownership verification: %w", err)
	}
	defer existing.Close()
	cfg, err := existing.Config()
	if err != nil {
		return fmt.Errorf("read YaseirAgent service configuration: %w", err)
	}
	expected, err := currentAgentExecutable()
	if err != nil {
		return err
	}
	matches, err := serviceBinaryMatchesInstallation(cfg.BinaryPathName, expected, "YaseirAgent.exe")
	if err != nil {
		return fmt.Errorf("verify YaseirAgent service binary ownership: %w", err)
	}
	if !matches {
		return fmt.Errorf(
			"refusing to manage YaseirAgent because its configured binary is not this installation: %q",
			cfg.BinaryPathName,
		)
	}
	return nil
}

func installationExecutableCandidates(currentExecutable, expectedBasename string) ([]string, error) {
	current, err := normalizeWindowsExecutablePath(currentExecutable)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(current, `\\`) {
		return nil, fmt.Errorf("current Agent executable is on a network path: %q", current)
	}
	dir := filepath.Dir(current)
	var installRoot string
	if strings.EqualFold(filepath.Base(dir), "resources") {
		installRoot = filepath.Dir(dir)
	} else {
		installRoot = dir
	}
	return []string{
		filepath.Clean(filepath.Join(installRoot, expectedBasename)),
		filepath.Clean(filepath.Join(installRoot, "resources", expectedBasename)),
	}, nil
}

func serviceBinaryMatchesInstallation(binaryPath, currentExecutable, expectedBasename string) (bool, error) {
	candidates, err := installationExecutableCandidates(currentExecutable, expectedBasename)
	if err != nil {
		return false, err
	}
	for _, candidate := range candidates {
		matches, matchErr := serviceBinaryMatchesExact(binaryPath, candidate)
		if matchErr != nil {
			return false, matchErr
		}
		if matches {
			return true, nil
		}
	}
	return false, nil
}

func legacyAgentExecutableCandidates(expectedBasename string) ([]string, error) {
	current, err := currentAgentExecutable()
	if err != nil {
		return nil, err
	}
	return installationExecutableCandidates(current, expectedBasename)
}

func verifyLegacyAgentServiceOwnership(existing *mgr.Service, name string) error {
	expectedBasename, ok := map[string]string{
		"YasserAgent":    "YasserAgent.exe",
		"OdooPrintAgent": "OdooPrintAgent.exe",
	}[name]
	if !ok {
		return fmt.Errorf("unsupported legacy service identity %q", name)
	}
	cfg, err := existing.Config()
	if err != nil {
		return fmt.Errorf("read legacy service %s configuration: %w", name, err)
	}
	executable, err := serviceCommandExecutable(cfg.BinaryPathName)
	if err != nil {
		return fmt.Errorf("verify legacy service %s binary ownership: %w", name, err)
	}
	executable, err = normalizeWindowsExecutablePath(executable)
	if err != nil {
		return fmt.Errorf("verify legacy service %s binary ownership: %w", name, err)
	}
	if strings.HasPrefix(executable, `\\`) {
		return fmt.Errorf("refusing to manage legacy service %s from a network executable: %q", name, executable)
	}
	candidates, err := legacyAgentExecutableCandidates(expectedBasename)
	if err != nil {
		return fmt.Errorf("resolve trusted legacy service locations for %s: %w", name, err)
	}
	for _, candidate := range candidates {
		if strings.EqualFold(executable, candidate) {
			return nil
		}
	}
	return fmt.Errorf(
		"refusing to manage legacy service %s because its configured binary is outside this installation: %q",
		name,
		cfg.BinaryPathName,
	)
}

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
	matches, err := serviceBinaryMatchesInstallation(current.BinaryPathName, executable, "YaseirAgent.exe")
	if err != nil {
		return fmt.Errorf("verify existing %s service binary before update: %w", wanted.Name, err)
	}
	if !matches {
		return fmt.Errorf("refusing to update %s because its configured binary is not this installation: %q", wanted.Name, current.BinaryPathName)
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

// configureServiceRecovery declares SCM failure actions so a crashed Agent
// restarts itself (60s delay, 3 attempts, counter reset daily). Use the native
// SCM API instead of resolving/executing sc.exe from inherited process state.
// Failure is warn-only: recovery policy should not invalidate an otherwise
// correctly installed service.
func configureServiceRecovery(serviceName string) {
	manager, err := mgr.Connect()
	if err != nil {
		log.Printf("WARNING: connect to Windows Service Control Manager for recovery actions: %v", err)
		return
	}
	defer manager.Disconnect()

	existing, err := manager.OpenService(serviceName)
	if err != nil {
		log.Printf("WARNING: open %s for recovery actions: %v", serviceName, err)
		return
	}
	defer existing.Close()

	cfg, err := existing.Config()
	if err != nil {
		log.Printf("WARNING: read %s service configuration before recovery update: %v", serviceName, err)
		return
	}
	expected, err := currentAgentExecutable()
	if err != nil {
		log.Printf("WARNING: resolve Agent executable before recovery update: %v", err)
		return
	}
	matches, err := serviceBinaryMatchesExact(cfg.BinaryPathName, expected)
	if err != nil || !matches {
		if err != nil {
			log.Printf("WARNING: verify %s ownership before recovery update: %v", serviceName, err)
		} else {
			log.Printf("WARNING: refusing to configure recovery for %s because its binary is not this installation: %q", serviceName, cfg.BinaryPathName)
		}
		return
	}

	actions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}
	if err := existing.SetRecoveryActions(actions, 24*60*60); err != nil {
		log.Printf("WARNING: configuring service recovery actions failed: %v", err)
		return
	}
	log.Printf("Service recovery actions configured (restart on crash)")
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

		if err := verifyLegacyAgentServiceOwnership(existing, name); err != nil {
			_ = existing.Close()
			return err
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
