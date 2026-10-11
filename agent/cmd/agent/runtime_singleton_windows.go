//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	kernel32RuntimeSingleton = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW         = kernel32RuntimeSingleton.NewProc("CreateMutexW")
	procReleaseMutex         = kernel32RuntimeSingleton.NewProc("ReleaseMutex")
	procCloseHandle          = kernel32RuntimeSingleton.NewProc("CloseHandle")
)

func acquireAgentRuntimeSingleton(_ string) (func(), error) {
	// Machine-global by design: the Windows service model runs one agent.
	// The config path parameter exists for signature parity with the POSIX
	// per-config flock; it is intentionally unused here.
	name, err := syscall.UTF16PtrFromString(`Global\YaseirAgent.Runtime.Singleton.v1`)
	if err != nil {
		return nil, fmt.Errorf("encode Agent runtime mutex name: %w", err)
	}
	handle, _, callErr := procCreateMutexW.Call(0, 1, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, fmt.Errorf("create Agent runtime mutex: %v", callErr)
	}
	const errorAlreadyExists syscall.Errno = 183
	if errno, ok := callErr.(syscall.Errno); ok && errno == errorAlreadyExists {
		procCloseHandle.Call(handle)
		return nil, fmt.Errorf("another YaseirAgent runtime is already active")
	}
	release := func() {
		procReleaseMutex.Call(handle)
		procCloseHandle.Call(handle)
	}
	return release, nil
}
