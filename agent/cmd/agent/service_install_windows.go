//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

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
