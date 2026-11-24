package dependencysecurity

import (
	"strings"
	"testing"

	"github.com/moby/sys/user"
)

// These are bounded local fixtures for the upstream parser advisory. They do
// not modify /etc/passwd, change a user identity, or exhaust host resources.
func TestPasswdRejectsOversizedLine(t *testing.T) {
	_, err := user.ParsePasswd(strings.NewReader("worker:x:1000:1000:" + strings.Repeat("x", 128*1024) + ":/home/worker:/bin/sh\n"))
	if err == nil {
		t.Fatal("oversized passwd line was accepted without a parser bound")
	}
}

func TestGroupRejectsOversizedLine(t *testing.T) {
	_, err := user.ParseGroup(strings.NewReader("staff:x:1000:" + strings.Repeat("x", 2*1024*1024) + "\n"))
	if err == nil {
		t.Fatal("oversized group line was accepted without a parser bound")
	}
}

func TestOrdinaryPasswdIdentity(t *testing.T) {
	users, err := user.ParsePasswd(strings.NewReader("worker:x:1000:1001:Worker:/home/worker:/bin/sh\n"))
	if err != nil || len(users) != 1 || users[0].Name != "worker" || users[0].Uid != 1000 || users[0].Gid != 1001 {
		t.Fatalf("ordinary passwd identity changed: %#v, %v", users, err)
	}
}

func TestOrdinaryGroupMembership(t *testing.T) {
	groups, err := user.ParseGroup(strings.NewReader("staff:x:1001:worker,operator\n"))
	if err != nil || len(groups) != 1 || groups[0].Gid != 1001 || strings.Join(groups[0].List, ",") != "worker,operator" {
		t.Fatalf("ordinary group membership changed: %#v, %v", groups, err)
	}
}
