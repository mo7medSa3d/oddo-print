package config

// ReplaceFile atomically replaces dst with src.
//
// On Windows this uses MoveFileExW with MOVEFILE_REPLACE_EXISTING |
// MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH and retries transient
// lock contention (antivirus, desktop scanners) with a short backoff. On
// POSIX it renames atomically within a filesystem and syncs the containing
// directory after replacement.
//
// Callers must have written and closed src (and ideally fsync'ed it)
// beforehand. The destination is replaced in place, so its path and
// permissions are preserved by the caller, not by this helper.
func ReplaceFile(src, dst string) error {
	return replaceFile(src, dst)
}
