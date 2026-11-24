//go:build !windows

package storage

import (
	"fmt"
	"os"
)

// EnsureSecureDirectoryACL sets restrictive owner-only permissions (0700) on POSIX.
func EnsureSecureDirectoryACL(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("refusing non-directory security path %s", path)
	}
	return os.Chmod(path, 0700)
}

// EnsureSecureFileACL sets restrictive owner-only permissions (0600) on POSIX.
func EnsureSecureFileACL(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing non-regular security file %s", path)
	}
	return os.Chmod(path, 0600)
}
