//go:build !windows

package storage

// platformEncrypt/platformDecrypt are an identity transform on non-Windows
// platforms: the store file holds base64-framed secrets protected ONLY by
// 0600/0700 filesystem DACL (see secure.go SaveSecret). There is no
// DPAPI/keyring equivalent here, and base64 is an encoding, not encryption —
// anyone who can read the file recovers the credential with one decode.
//
// This is a conscious platform limitation, not a development-only fallback:
// the Makefile ships a linux/arm64 target, so POSIX is a supported
// deployment path. Deployments that need at-rest secrecy on POSIX must use
// full-disk encryption (e.g. LUKS on Raspberry Pi) and restrict host access;
// the 0600 mode only defends against other unprivileged UIDs on the same
// intact host. Do not weaken this comment without adding real key material.
func platformEncrypt(data []byte) ([]byte, error) {
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}

func platformDecrypt(data []byte) ([]byte, error) {
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}
