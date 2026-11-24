//go:build !windows

package storage

import (
	"fmt"
	"os"
	"path/filepath"
)

func replaceFile(src, dst string) error {
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	// Persist the rename itself; syncing the file does not flush its directory entry.
	dir, err := os.Open(filepath.Dir(dst))
	if err != nil {
		return fmt.Errorf("open replaced file directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync replaced file directory: %w", err)
	}
	return nil
}
