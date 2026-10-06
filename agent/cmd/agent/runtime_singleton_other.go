//go:build !windows

package main

func acquireAgentRuntimeSingleton() (func(), error) {
	return func() {}, nil
}
