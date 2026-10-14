package printer

import (
	"reflect"
	"testing"
)

func TestUnverifiedWindowsSessionKeepsConnectionsAsSetupEvidence(t *testing.T) {
	connection := inventoryTestDevice("user-queue", "spooler", "spooler", `\\server\Receipt`, "discovery", SourceSpooler)
	connection.Status = "online"
	connection.Capabilities["spooler_scope"] = "user_connection"
	connection.Capabilities["supported_protocols"] = []string{"pdf", "image"}
	originalCaps := connection.Capabilities
	machine := inventoryTestDevice("machine-queue", "spooler", "spooler", "Office Queue", "discovery", SourceSpooler)
	machine.Capabilities["spooler_scope"] = "machine_local"
	infos := []DeviceInfo{connection, machine}
	if got := markUserSpoolerConnectionScope(infos, 0, false); got != 1 {
		t.Fatalf("unknown session must mark only the per-user connection: %d", got)
	}
	if got := runtimeInventoryPrintersForPlatform(infos, "windows"); len(got) != 1 || got[0].ID != machine.ID {
		t.Fatalf("unverified account connection entered service inventory or valid machine queue disappeared: %#v", got)
	}
	if infos[0].Status != "online" || infos[0].ID != connection.ID || infos[0].SpoolerName != connection.SpoolerName {
		t.Fatal("scope admission changed actual observed health or queue identity")
	}
	if infos[0].Capabilities["candidate_reason"] != "spooler_session_unverified" ||
		infos[0].Capabilities["runtime_scope"] != "unverified_session_discovery_only" {
		t.Fatalf("unknown session was misreported as a proven interactive session: %#v", infos[0].Capabilities)
	}
	if _, changed := originalCaps["verification"]; changed {
		t.Fatal("scope enrichment mutated a previously published capability snapshot")
	}
	if !reflect.DeepEqual(infos[0].Capabilities["supported_protocols"], []string{"pdf", "image"}) {
		t.Fatal("scope enrichment discarded independently observed capabilities")
	}
	for _, source := range []string{"manual", "config"} {
		infos[0].Capabilities["registration_source"] = source
		if got := runtimeInventoryPrintersForPlatform(infos, "windows"); len(got) != 2 {
			t.Fatalf("scope proof erased an explicit %s operator selection", source)
		}
	}
}

func TestKnownWindowsSessionPreservesAccountScopePolicy(t *testing.T) {
	for _, test := range []struct {
		name          string
		sessionID     uint32
		wantMarked    int
		wantInventory int
	}{
		{"service account", 0, 0, 1},
		{"interactive account", 3, 1, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			connection := inventoryTestDevice("user-queue", "spooler", "spooler", `\\server\Receipt`, "discovery", SourceSpooler)
			connection.Capabilities["spooler_scope"] = "user_connection"
			infos := []DeviceInfo{connection}
			if got := markUserSpoolerConnectionScope(infos, test.sessionID, true); got != test.wantMarked {
				t.Fatalf("marked=%d want=%d", got, test.wantMarked)
			}
			if got := len(runtimeInventoryPrintersForPlatform(infos, "windows")); got != test.wantInventory {
				t.Fatalf("main inventory=%d want=%d", got, test.wantInventory)
			}
			if test.wantMarked == 1 && infos[0].Capabilities["candidate_reason"] != "per_user_spooler_connection" {
				t.Fatal("known interactive account lost its existing diagnostic reason")
			}
		})
	}
}
