//go:build windows

package printer

import (
	"golang.org/x/sys/windows/registry"
)

// scanUserPrinterConnections reads every loaded user profile's
// Printers\Connections key and returns the connections it finds. It is
// strictly read-only evidence for the visibility diagnostic: the rows
// are never turned into inventory, because the service account cannot
// open another user's connections. ok=false means the hive could not
// be read at all (callers fall back to the generic guidance); partial
// per-profile failures simply contribute fewer rows.
func scanUserPrinterConnections() (conns []userPrinterConnection, ok bool) {
	users, err := registry.OpenKey(registry.USERS, "", registry.READ)
	if err != nil {
		return nil, false
	}
	defer users.Close()
	sids, err := users.ReadSubKeyNames(-1)
	if err != nil {
		return nil, false
	}
	for _, sid := range sids {
		if !isUserProfileSID(sid) {
			continue
		}
		key, err := registry.OpenKey(registry.USERS, sid+`\Printers\Connections`, registry.READ)
		if err != nil {
			continue // profile has no connections key (or is not loaded)
		}
		names, readErr := key.ReadSubKeyNames(-1)
		key.Close()
		if readErr != nil {
			continue
		}
		for _, raw := range names {
			if server, queue, parsed := parseUserConnectionKeyName(raw); parsed {
				conns = append(conns, userPrinterConnection{UserSID: sid, Server: server, Queue: queue})
			}
		}
	}
	return conns, true
}
