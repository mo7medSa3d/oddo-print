package storage

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	if err := s.SaveSecret("agent-secret", "s3cr3t-value"); err != nil {
		t.Fatalf("SaveSecret: %v", err)
	}
	got, err := s.GetSecret("agent-secret")
	if err != nil {
		t.Fatalf("GetSecret: %v", err)
	}
	if got != "s3cr3t-value" {
		t.Fatalf("round trip mismatch: %q", got)
	}

	// Overwriting the same key must work and leave a single entry.
	if err := s.SaveSecret("agent-secret", "updated-value"); err != nil {
		t.Fatalf("SaveSecret update: %v", err)
	}
	got, err = s.GetSecret("agent-secret")
	if err != nil || got != "updated-value" {
		t.Fatalf("update mismatch: %q err=%v", got, err)
	}

	// A second key must not clobber the first.
	if err := s.SaveSecret("second-key", "beta"); err != nil {
		t.Fatalf("SaveSecret second: %v", err)
	}
	if got, err = s.GetSecret("second-key"); err != nil || got != "beta" {
		t.Fatalf("second key mismatch: %q err=%v", got, err)
	}
	if got, err = s.GetSecret("agent-secret"); err != nil || got != "updated-value" {
		t.Fatalf("first key clobbered: %q err=%v", got, err)
	}

	if _, err := s.GetSecret("missing-key"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	// The secret must never be readable as plaintext from the file: on
	// Windows it is DPAPI ciphertext, on other platforms base64 framing.
	data, err := os.ReadFile(filepath.Join(dir, secretFile))
	if err != nil {
		t.Fatalf("read store file: %v", err)
	}
	if bytes.Contains(data, []byte("updated-value")) || bytes.Contains(data, []byte("beta")) {
		t.Fatal("secret file contains plaintext secrets")
	}
	// Base64 framing is trivially reversible, so on non-Windows platforms the
	// 0600 file mode is the ONLY protection. Pin it: a world-readable store
	// file would disclose the Gateway credential to every local user.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, secretFile))
		if err != nil {
			t.Fatalf("stat store file: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("secret store file mode = %04o, want 0600", perm)
		}
	}
}

func TestEmptyDirRejected(t *testing.T) {
	s := NewStore("")
	if err := s.SaveSecret("k", "v"); err == nil {
		t.Fatal("expected error for empty Dir")
	}
}

func TestIsUserDirectory(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{`C:\ProgramData\OdooPrintAgent`, false},
		{`C:\Program Files\OdooPrintAgent`, false},
		{`C:\Users\JohnDoe\AppData\Local\OdooPrintAgent`, true},
		{`C:\users\admin\config.yaml`, true},
		{`/home/user/.local/share`, true},
		{`/var/lib/odoo-print-agent`, false},
	}

	for _, tc := range cases {
		got := IsUserDirectory(tc.path)
		if got != tc.want {
			t.Errorf("IsUserDirectory(%q) = %v; want %v", tc.path, got, tc.want)
		}
	}
}
