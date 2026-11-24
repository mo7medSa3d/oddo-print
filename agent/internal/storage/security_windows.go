//go:build windows

package storage

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func getCurrentUserSID() (string, error) {
	tok, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer tok.Close()

	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

func secureOwnerSID(path string) (*windows.SID, error) {
	if IsUserDirectory(path) {
		value, err := getCurrentUserSID()
		if err != nil {
			return nil, err
		}
		return windows.StringToSid(value)
	}
	return windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
}

func rejectWindowsReparsePoint(path string) error {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("invalid Windows path %q: %w", path, err)
	}
	attrs, err := windows.GetFileAttributes(ptr)
	if err != nil {
		return fmt.Errorf("read Windows file attributes for %s: %w", path, err)
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("refusing security-sensitive path through a Windows reparse point: %s", path)
	}
	return nil
}

// BuildSecureSDDL returns the appropriate SDDL depending on whether the directory is
// a per-user directory (%LOCALAPPDATA% / %USERPROFILE%) or a system-wide service directory (%ProgramData%).
func BuildSecureSDDL(path string) (string, error) {
	if IsUserDirectory(path) {
		userSID, err := getCurrentUserSID()
		if err != nil {
			return "", fmt.Errorf("failed to get current user SID: %w", err)
		}
		return fmt.Sprintf("D:P(A;OICI;GA;;;%s)(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)", userSID), nil
	}
	return "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)", nil
}

// EnsureSecureDirectoryACL enforces strict NTFS permissions on the target directory.
// System-wide service data is writable only by SYSTEM and Administrators. A
// per-user data directory is writable by its owning user, SYSTEM and
// Administrators. Standard Users never receive write access to service data
// that is later consumed by a LocalSystem service.
func EnsureSecureDirectoryACL(path string) error {
	if err := rejectWindowsReparsePoint(path); err != nil {
		return err
	}
	sddl, err := BuildSecureSDDL(path)
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("failed to parse SDDL %q: %w", sddl, err)
	}

	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("failed to get DACL: %w", err)
	}
	owner, err := secureOwnerSID(path)
	if err != nil {
		return fmt.Errorf("resolve secure owner for %s: %w", path, err)
	}

	err = windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner,
		nil,
		dacl,
		nil,
	)
	if err != nil {
		return fmt.Errorf("failed to set secure NTFS owner/permissions on %s: %w", path, err)
	}
	return nil
}

// EnsureSecureFileACL protects one existing file with the same trust model as
// its parent directory. It is needed for files created before the directory
// ACL was hardened; directory protection alone does not rewrite an existing
// child object's explicit DACL.
func EnsureSecureFileACL(path string) error {
	if err := rejectWindowsReparsePoint(path); err != nil {
		return err
	}
	parent := filepath.Dir(path)
	sddl, err := BuildSecureSDDL(parent)
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("failed to parse file SDDL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("failed to get file DACL: %w", err)
	}
	owner, err := secureOwnerSID(parent)
	if err != nil {
		return fmt.Errorf("resolve secure owner for %s: %w", path, err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner,
		nil,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("failed to set secure NTFS owner/permissions on %s: %w", path, err)
	}
	return nil
}
