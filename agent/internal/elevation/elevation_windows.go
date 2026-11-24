//go:build windows

package elevation

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modShell32        = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteW = modShell32.NewProc("ShellExecuteW")
)

const swShowNormal = 1 // ShellExecuteW SW_SHOWNORMAL

// relaunchSentinel is appended to the elevated copy's command line so
// the gate can tell a relaunched process from a fresh launch and never
// loop the UAC prompt. main() registers it as a real flag so the
// child's flag parsing accepts it.
const relaunchSentinel = "-elevated-relaunch"

func processElevated() bool {
	// Token.IsElevated reports false for a non-elevated (filtered)
	// token, which is exactly the case this gate must block.
	return windows.GetCurrentProcessToken().IsElevated()
}

func utf16Ptr(s string) *uint16 {
	ptr, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return nil
	}
	return ptr
}

// relaunchElevated starts an elevated copy of this executable with the
// same arguments (plus the relaunch sentinel) via the shell "runas"
// verb, which raises the UAC consent prompt — the only prompt in the
// whole flow; there is no application dialog. ShellExecuteW returns a
// value > 32 on success; a declined UAC prompt surfaces as an error,
// which the gate treats as "do not open".
func relaunchElevated() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := append([]string{relaunchSentinel}, os.Args[1:]...)
	verb := utf16Ptr("runas")
	file := utf16Ptr(exe)
	params := utf16Ptr(joinCommandLineArgs(args))
	if verb == nil || file == nil || params == nil {
		return errors.New("could not encode elevated relaunch parameters")
	}
	ret, _, callErr := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		uintptr(unsafe.Pointer(params)),
		0,
		swShowNormal,
	)
	if ret <= 32 {
		if callErr != nil {
			return callErr
		}
		return syscall.Errno(ret)
	}
	return nil
}

// joinCommandLineArgs renders argv the way the Windows command line
// expects: arguments containing spaces or quotes are wrapped in double
// quotes with embedded quotes/backslash runs escaped. Agent launches
// are normally bare or simple subcommands, but install paths and
// config paths can contain spaces.
func joinCommandLineArgs(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		if arg != "" && !strings.ContainsAny(arg, " \t\"") {
			quoted = append(quoted, arg)
			continue
		}
		var b strings.Builder
		b.WriteByte('"')
		backslashes := 0
		for _, r := range arg {
			switch r {
			case '\\':
				backslashes++
			case '"':
				b.WriteString(strings.Repeat("\\", backslashes*2+1))
				b.WriteByte('"')
				backslashes = 0
			default:
				b.WriteString(strings.Repeat("\\", backslashes))
				b.WriteRune(r)
				backslashes = 0
			}
		}
		b.WriteString(strings.Repeat("\\", backslashes*2))
		b.WriteByte('"')
		quoted = append(quoted, b.String())
	}
	return strings.Join(quoted, " ")
}
