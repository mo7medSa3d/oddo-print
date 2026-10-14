package printer

import "strings"

// UNC queues need current server evidence. A failed fresh query must never
// fall back to a cached result presented as the queue's current status.
func openSpoolerQuery(queueName string, local, remote func() (uintptr, error)) (uintptr, error) {
	if strings.HasPrefix(queueName, `\\`) {
		return remote()
	}
	return local()
}

// A registry name survives stopped spoolers and queue removal. Retain it for
// setup diagnostics without treating it as a currently enumerated queue.
func registrySpoolerCandidate(name string) DeviceInfo {
	return DeviceInfo{
		Name: name, Protocol: "spooler", ConnectionType: "spooler",
		Endpoint: name, SpoolerName: name, Status: "unknown",
		Capabilities: map[string]interface{}{
			"discovered_via":   SourceSpooler,
			"verification":     "candidate_only",
			"candidate_reason": "registry_queue_unverified",
			"runtime_scope":    "registry_discovery_only",
		},
	}
}
