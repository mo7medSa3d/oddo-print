//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestCallerProductDataRootsAreExactChildrenOfKnownFolders(t *testing.T) {
	local := `C:\Users\Example\AppData\Local`
	roaming := `C:\Users\Example\AppData\Roaming`
	paths, err := callerProductDataRoots(local, roaming)
	if err != nil {
		t.Fatalf("trusted caller AppData: %v", err)
	}
	if len(paths) != 12 {
		t.Fatalf("expected 12 exact product roots, got %d: %#v", len(paths), paths)
	}
	required := map[string]bool{
		filepath.Join(local, "com.yasser.manager"):   false,
		filepath.Join(roaming, "com.yasser.manager"): false,
		filepath.Join(local, "YaseirManager"):        false,
	}
	for _, p := range paths {
		if p != filepath.Clean(p) {
			t.Fatalf("unclean product path %q", p)
		}
		parent := filepath.Dir(p)
		if !strings.EqualFold(parent, local) && !strings.EqualFold(parent, roaming) {
			t.Fatalf("product root escapes caller Known Folders: %q", p)
		}
		if _, ok := required[p]; ok {
			required[p] = true
		}
	}
	for p, found := range required {
		if !found {
			t.Errorf("missing product-owned path %q", p)
		}
	}
}

func TestCallerProductDataRootsRejectsUnknownOrRelativeFolders(t *testing.T) {
	for _, input := range []string{"", "   ", `..\somewhere`, `AppData\Local`} {
		if _, err := callerProductDataRoots(input, `C:\Users\Example\AppData\Roaming`); err == nil {
			t.Errorf("untrusted data root %q was accepted", input)
		}
	}
}

func TestCallerOwnedUserDataRootsUseTheCurrentWindowsIdentity(t *testing.T) {
	paths, err := callerOwnedUserDataRoots()
	if err != nil {
		t.Fatalf("Windows Known Folder discovery: %v", err)
	}
	token, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if token.User.Sid.IsWellKnown(windows.WinLocalSystemSid) ||
		token.User.Sid.IsWellKnown(windows.WinLocalServiceSid) ||
		token.User.Sid.IsWellKnown(windows.WinNetworkServiceSid) {
		if len(paths) != 0 {
			t.Fatalf("service identity must not purge an interactive user: %#v", paths)
		}
		return
	}
	if len(paths) == 0 {
		t.Fatal("real interactive caller must include its own profile cleanup")
	}
	local, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		t.Fatal(err)
	}
	roaming, err := windows.KnownFolderPath(windows.FOLDERID_RoamingAppData, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range paths {
		dir := filepath.Dir(p)
		if !strings.EqualFold(dir, local) && !strings.EqualFold(dir, roaming) {
			t.Fatalf("unexpected caller-owned root %q", p)
		}
	}
}
