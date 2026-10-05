//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
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

func purgeInstallationData() error {
	var roots []string
	if programData := strings.TrimSpace(os.Getenv("PROGRAMDATA")); programData != "" {
		for _, name := range []string{
			"YaseirAgent",
			"YasserAgent",
			"OdooPrintAgent",
			"YaseirManager",
			"YasserManager",
			"OdooPrintManager",
		} {
			roots = append(roots, filepath.Join(programData, name))
		}
	}
	userDataNames := []string{
		"YaseirManager",
		"YasserManager",
		"Yaseir Print Manager",
		"Yasser Print Manager",
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
	// the interactive user's profile. Enumerate fixed product subdirectories
	// under every local profile so uninstall leaves no Yaseir cache/session
	// state behind for another login.
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

	var failures []string
	for _, root := range roots {
		if err := os.RemoveAll(root); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", root, err))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("purge Yaseir installation data: %s", strings.Join(failures, "; "))
	}
	return nil
}
