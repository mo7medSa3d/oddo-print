//go:build !windows

package main

import (
	"errors"
	"fmt"

	"github.com/kardianos/service"
)

func serviceRemovalAlreadyComplete(err error) bool {
	return errors.Is(err, service.ErrNotInstalled)
}

func verifyCurrentAgentServiceOwnershipIfPresent() error {
	return nil
}

func updateInstalledService(_ *service.Config) error {
	return fmt.Errorf("existing service upgrades are only supported on Windows")
}

func configureServiceRecovery(_ string) {}

func purgeLegacyAgentServices() error {
	return nil
}

func purgeAgentData() error {
	return fmt.Errorf("Agent data purge is only supported on Windows")
}

func purgeInstallationData() error {
	return fmt.Errorf("installation data purge is only supported on Windows")
}
