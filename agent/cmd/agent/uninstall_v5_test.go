package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUninstallRetainsDataUntilOwnedLegacyServicesAreRemoved(t *testing.T) {
	for _, stopFails := range []bool{false, true} {
		name := "removed"
		if stopFails {
			name = "removal_refused"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			queuePath := filepath.Join(dir, "jobs.db")
			original := []byte("durable print outcome awaiting reconciliation")
			if err := os.WriteFile(queuePath, original, 0600); err != nil {
				t.Fatal(err)
			}
			removalErr := errors.New("owned legacy service still running")
			stopped := false
			err := completeAgentUninstall(func() error {
				if stopFails {
					return removalErr
				}
				stopped = true
				return nil
			}, func() error {
				if !stopped {
					t.Error("uninstall reached data purge while a legacy service could still own the queue")
				}
				return os.Remove(queuePath)
			})
			if stopFails {
				if !errors.Is(err, removalErr) {
					t.Fatalf("legacy removal failure not returned: %v", err)
				}
				if data, err := os.ReadFile(queuePath); err != nil || string(data) != string(original) {
					t.Fatalf("failed service removal deleted durable queue: %q %v", data, err)
				}
			} else if err != nil {
				t.Fatal(err)
			} else if _, err := os.Stat(queuePath); !os.IsNotExist(err) {
				t.Fatalf("explicit uninstall did not purge data after service removal: %v", err)
			}
		})
	}
}
