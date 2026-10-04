//go:build !windows

package config

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
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
