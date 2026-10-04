//go:build windows

package config

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"syscall"
	"time"
	"unsafe"
)

const (
	moveFileReplaceExisting = 0x1
	moveFileCopyAllowed     = 0x2
	moveFileWriteThrough    = 0x8
)

var procMoveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

func replaceFile(src, dst string) error {
	from, err := syscall.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}

	flags := uintptr(moveFileReplaceExisting | moveFileCopyAllowed | moveFileWriteThrough)

	// Retry with exponential backoff on transient Windows file lock contention (e.g. antivirus, desktop scanner)
	const maxAttempts = 3
	backoff := 50 * time.Millisecond

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		r, _, callErr := procMoveFileExW.Call(
			uintptr(unsafe.Pointer(from)),
			uintptr(unsafe.Pointer(to)),
			flags,
		)
		if r != 0 {
			return nil
		}
		if callErr != nil {
			lastErr = callErr
		} else {
			lastErr = fmt.Errorf("MoveFileExW failed")
		}

		if attempt < maxAttempts {
			time.Sleep(backoff)
			backoff *= 2
		}
	}
	return fmt.Errorf("MoveFileExW failed after %d attempts: %w", maxAttempts, lastErr)
}

func tryLocalFileLock(file *os.File) (func() error, error) {
	var overlapped windows.Overlapped
	handle := windows.Handle(file.Fd())
	err := windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return nil, fmt.Errorf("%w: %v", errLocalLockBusy, err)
	}
	if err != nil {
		return nil, err
	}
	return func() error { return windows.UnlockFileEx(handle, 0, 1, 0, &overlapped) }, nil
}
