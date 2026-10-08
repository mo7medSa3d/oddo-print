//go:build windows

package main

import (
	"testing"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
)

func TestServiceCommandExecutableQuotedWithArguments(t *testing.T) {
	got, err := serviceCommandExecutable(`"C:\Program Files\Yaseir\resources\YaseirAgent.exe" -config "C:\ProgramData\YaseirAgent\config.yaml"`)
	if err != nil {
		t.Fatalf("parse service command: %v", err)
	}
	if got != `C:\Program Files\Yaseir\resources\YaseirAgent.exe` {
		t.Fatalf("unexpected executable %q", got)
	}
}

func TestServiceCommandExecutableRejectsUnterminatedQuote(t *testing.T) {
	if _, err := serviceCommandExecutable(`"C:\Program Files\Yaseir\YaseirAgent.exe`); err == nil {
		t.Fatal("unterminated quoted service path must be rejected")
	}
}

func TestServiceBinaryMatchesExactNormalizesExtendedPrefixAndCase(t *testing.T) {
	matches, err := serviceBinaryMatchesExact(
		`"\\?\C:\Program Files\Yaseir\YaseirAgent.exe" -config x`,
		`c:\program files\yaseir\YaseirAgent.exe`,
	)
	if err != nil {
		t.Fatalf("match service path: %v", err)
	}
	if !matches {
		t.Fatal("extended path prefix and case must preserve executable identity")
	}
}

func TestCurrentServiceOwnershipAcceptsRootOrResourcesWithinSameInstall(t *testing.T) {
	current := `C:\Program Files\Yaseir\resources\YaseirAgent.exe`
	for _, binaryPath := range []string{
		`"C:\Program Files\Yaseir\resources\YaseirAgent.exe" -config x`,
		`"C:\Program Files\Yaseir\YaseirAgent.exe" -config x`,
	} {
		matches, err := serviceBinaryMatchesInstallation(binaryPath, current, "YaseirAgent.exe")
		if err != nil || !matches {
			t.Fatalf("same-install current service must match: path=%q matches=%v err=%v", binaryPath, matches, err)
		}
	}
	matches, err := serviceBinaryMatchesInstallation(
		`"C:\Other Product\YaseirAgent.exe" -config x`,
		current,
		"YaseirAgent.exe",
	)
	if err != nil {
		t.Fatalf("compare unrelated current service: %v", err)
	}
	if matches {
		t.Fatal("same current-service basename outside this installation must not prove ownership")
	}
}

func TestLegacyServiceCandidatesStayInsideCurrentInstallation(t *testing.T) {
	current := `C:\Program Files\Yaseir\resources\YaseirAgent.exe`
	candidates, err := installationExecutableCandidates(current, "YasserAgent.exe")
	if err != nil {
		t.Fatalf("derive legacy candidates: %v", err)
	}
	want := map[string]bool{
		`C:\Program Files\Yaseir\resources\YasserAgent.exe`: false,
		`C:\Program Files\Yaseir\YasserAgent.exe`:           false,
	}
	for _, candidate := range candidates {
		if _, ok := want[candidate]; ok {
			want[candidate] = true
		}
	}
	for candidate, seen := range want {
		if !seen {
			t.Fatalf("missing trusted legacy candidate %q in %#v", candidate, candidates)
		}
	}
	for _, candidate := range candidates {
		if candidate == `C:\Other Product\YasserAgent.exe` {
			t.Fatal("unrelated same-name executable must never become a trusted legacy candidate")
		}
	}
}


func TestServiceRemovalAlreadyCompleteAcceptsAbsentOrPendingDeletion(t *testing.T) {
	for _, err := range []error{
		service.ErrNotInstalled,
		windows.ERROR_SERVICE_DOES_NOT_EXIST,
		windows.ERROR_SERVICE_MARKED_FOR_DELETE,
	} {
		if !serviceRemovalAlreadyComplete(err) {
			t.Fatalf("service removal should treat %v as already complete", err)
		}
	}
	if serviceRemovalAlreadyComplete(windows.ERROR_ACCESS_DENIED) {
		t.Fatal("access denied must remain a fatal service-removal error")
	}
}
