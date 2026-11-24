//go:build !windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
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

func tryLocalFileLock(file *os.File) (func() error, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return nil, fmt.Errorf("%w: %v", errLocalLockBusy, err)
	}
	if err != nil {
		return nil, err
	}
	return func() error { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }, nil
}
