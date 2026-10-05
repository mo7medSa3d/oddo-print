//go:build !windows

package main

import (
	"fmt"
	"github.com/kardianos/service"
)

func updateInstalledService(_ *service.Config) error {
	return fmt.Errorf("existing service upgrades are only supported on Windows")
}


func purgeInstallationData() error {
	return fmt.Errorf("installation data purge is only supported on Windows")
}
