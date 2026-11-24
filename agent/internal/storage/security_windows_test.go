//go:build windows

package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestBuildSecureSDDL(t *testing.T) {
	// Service path (e.g. ProgramData)
	serviceSDDL, err := BuildSecureSDDL(`C:\ProgramData\OdooPrintAgent`)
	if err != nil {
		t.Fatalf("BuildSecureSDDL service path failed: %v", err)
	}
	expectedService := "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)"
	if serviceSDDL != expectedService {
		t.Errorf("BuildSecureSDDL service path = %q, want %q", serviceSDDL, expectedService)
	}
	if strings.Contains(serviceSDDL, ";;;BU)") || strings.Contains(serviceSDDL, ";;;BG)") {
		t.Fatalf("service data ACL must not grant write/read access to broad built-in groups: %q", serviceSDDL)
	}

	// User path (e.g. AppData)
	userSDDL, err := BuildSecureSDDL(`C:\Users\CurrentUser\AppData\Local\OdooPrintAgent`)
	if err != nil {
		t.Fatalf("BuildSecureSDDL user path failed: %v", err)
	}
	if !strings.HasPrefix(userSDDL, "D:P(A;OICI;GA;;;S-1-") {
		t.Errorf("BuildSecureSDDL user path expected current user SID, got %q", userSDDL)
	}
	if !strings.HasSuffix(userSDDL, "(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)") {
		t.Errorf("BuildSecureSDDL user path missing SYSTEM/Administrators ACEs: %q", userSDDL)
	}
}

func assertWindowsOwner(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo(%s): %v", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		t.Fatalf("Owner(%s): %v", path, err)
	}
	expected, err := secureOwnerSID(filepath.Dir(path))
	if err != nil {
		t.Fatalf("secureOwnerSID(%s): %v", path, err)
	}
	// A directory under a user temp path uses the current user as owner;
	// files inherit the same trust root. Compare SID strings so the assertion
	// is independent of localized account names.
	if owner.String() != expected.String() {
		t.Fatalf("owner(%s)=%s want %s", path, owner.String(), expected.String())
	}
}

func TestEnsureSecureDirectoryACL_Windows(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureSecureDirectoryACL(dir); err != nil {
		t.Fatalf("EnsureSecureDirectoryACL failed on temp dir: %v", err)
	}
	assertWindowsOwner(t, filepath.Join(dir, "."))

	file := filepath.Join(dir, "secret.dat")
	if err := os.WriteFile(file, []byte("secret"), 0600); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	if err := EnsureSecureFileACL(file); err != nil {
		t.Fatalf("EnsureSecureFileACL failed: %v", err)
	}
	assertWindowsOwner(t, file)
}

func TestSecureACLRejectsReparsePoints_Windows(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	link := filepath.Join(root, "link")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("Windows runner does not permit symlink creation: %v", err)
	}
	if err := EnsureSecureDirectoryACL(link); err == nil {
		t.Fatal("security-sensitive directory ACL helper must reject reparse points")
	}
}
