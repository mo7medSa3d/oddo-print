package printer

import "strings"

// Per-user printer connections as Windows stores them: a connection a
// user added for themselves lives under HKEY_USERS\<SID>\Printers\
// Connections and is visible ONLY to that account. The Agent service
// (LocalSystem, Session 0) cannot see, open, or print to another
// user's connections — they do not exist as far as its EnumPrinters is
// concerned. Discovery therefore cannot list them as printers; what it
// CAN do is notice they exist and tell the operator exactly which
// connections are user-only, instead of the printer silently never
// appearing (or a blanket warning that fires even when none exist).

// userPrinterConnection is one per-user connection found in a user
// profile hive.
type userPrinterConnection struct {
	UserSID string
	Server  string
	Queue   string
}

// isUserProfileSID reports whether an HKEY_USERS subkey name is a real
// user profile hive (as opposed to .DEFAULT, the system accounts, or a
// *_Classes companion key). Interactive local/domain accounts are
// S-1-5-21-*; Azure AD joined accounts are S-1-12-1-*.
func isUserProfileSID(key string) bool {
	if strings.HasSuffix(key, "_Classes") {
		return false
	}
	return strings.HasPrefix(key, "S-1-5-21-") || strings.HasPrefix(key, "S-1-12-1-")
}

// parseUserConnectionKeyName decodes one subkey name from
// <SID>\Printers\Connections. The stored format encodes the UNC
// \\server\queue with commas: ",,SERVER,Queue Name" (the two leading
// commas are the leading backslashes). Queue names may themselves
// contain commas, so everything after the server field is the queue.
func parseUserConnectionKeyName(raw string) (server, queue string, ok bool) {
	parts := strings.Split(raw, ",")
	fields := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(strings.Trim(p, "\\"))
		if p != "" {
			fields = append(fields, p)
		}
	}
	if len(fields) < 2 {
		return "", "", false
	}
	return fields[0], strings.Join(fields[1:], ","), true
}

// unseenUserConnections filters scanned per-user connections down to
// the ones the current discovery did NOT see as queues: a connection
// whose queue name matches an enumerated queue's name or share name
// (case-insensitively) is already visible to this account and is not
// a visibility problem.
func unseenUserConnections(conns []userPrinterConnection, infos []DeviceInfo) []userPrinterConnection {
	visible := make(map[string]bool)
	for _, info := range infos {
		for _, name := range []string{info.Name, info.SpoolerName, info.SpoolerShare} {
			if n := strings.ToLower(strings.TrimSpace(name)); n != "" {
				visible[n] = true
			}
		}
	}
	out := make([]userPrinterConnection, 0, len(conns))
	for _, c := range conns {
		if !visible[strings.ToLower(strings.TrimSpace(c.Queue))] {
			out = append(out, c)
		}
	}
	return out
}
