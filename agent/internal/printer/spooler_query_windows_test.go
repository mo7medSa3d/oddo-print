//go:build windows

package printer

import (
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestFreshPrinterQueryOptionsMatchWindowsSDKABI(t *testing.T) {
	// PRINTER_OPTIONSW contains two 32-bit values on both Win32 and Win64.
	if unsafe.Sizeof(printerOptions{}) != 8 || unsafe.Offsetof(printerOptions{}.dwFlags) != 4 || printerOptionNoCache != 1 {
		t.Fatal("OpenPrinter2W options do not match the Windows SDK layout/NO_CACHE flag")
	}
}

func TestDiscoveryQueueDetailsReadExactNativeStatus(t *testing.T) {
	const name = `\\print-server\طابعة POS80`
	openCalls := 0
	restore := setPrinterHooks(func(ptr *uint16) (syscall.Handle, error) {
		openCalls++
		if got := utf16PtrToString(ptr); got != name {
			t.Errorf("query changed Windows queue identity: %q", got)
		}
		return 4711, nil
	}, fakePrinterInfo2(PRINTER_STATUS_PRINTING, PRINTER_ATTRIBUTE_NETWORK))
	defer restore()
	detail, err := queueDetail(name)
	if err != nil || openCalls != 1 || detail.status != PRINTER_STATUS_PRINTING || detail.attributes != PRINTER_ATTRIBUTE_NETWORK {
		t.Fatalf("native detail evidence changed: detail=%#v calls=%d error=%v", detail, openCalls, err)
	}
}

func TestDiagnosticProbeCannotBypassNativeQueryOwnership(t *testing.T) {
	const name = "Reserved Windows Queue"
	release, err := reserveSpoolerPreflight(strings.ToLower(name))
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	probe := ProbeSpoolerQueue(name)
	if probe.Verdict != SpoolerStatusUnknown || probe.OpenPrinterOK || probe.GetPrinterOK || probe.GetPrinterError == "" {
		t.Fatalf("reserved queue diagnostic invented fresh evidence: %#v", probe)
	}
}

func TestSpoolerStatusDetailUsesSameSnapshotAndClearsFailedRead(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_PAPER_OUT|PRINTER_STATUS_PRINTING, 0)
	p := NewSpooler("Status Detail Queue", "")
	if p.Status() != "error" || p.StatusDetail() != "windows_paper_out" {
		t.Fatalf("lost native reason: detail=%q", p.StatusDetail())
	}
	restore := setPrinterHooks(func(*uint16) (syscall.Handle, error) { return 0, syscall.Errno(5) }, fakePrinterInfo2(0, 0))
	defer restore()
	// WP123: a failed fresh read no longer clears the reason to a bare
	// "unknown". The stale windows_paper_out reason must still be gone,
	// and stale raw bits must be cleared, but the per-printer failure
	// reason (OpenPrinter Win32 code 5, access denied) is preserved.
	if p.Status() != "unknown" || p.StatusDetail() != "spooler_open_failed_win32_5" || p.StatusRawHex() != "" {
		t.Fatalf("failed fresh read lost its reason or retained stale evidence: detail=%q raw=%q", p.StatusDetail(), p.StatusRawHex())
	}
}

func TestTimedOutSpoolerStatusCannotPublishLateNativeReason(t *testing.T) {
	withFakeQueue(t, PRINTER_STATUS_PAPER_OUT, 0)
	p := NewSpooler("Late Status Detail Queue", "")
	if p.Status() != "error" || p.StatusDetail() != "windows_paper_out" {
		t.Fatal("missing initial native paper-out evidence")
	}
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	restore := setPrinterHooks(func(*uint16) (syscall.Handle, error) {
		close(started)
		<-release
		return 4711, nil
	}, fakePrinterInfo2(PRINTER_STATUS_PAUSED, 0))
	defer restore()
	p.Timeout = 40 * time.Millisecond
	result := make(chan string, 1)
	go func() { result <- p.Status() }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("native status worker did not start")
	}
	// WP123: a timed-out read keeps a timeout reason instead of a bare
	// "unknown", but still never the stale windows_paper_out reason.
	if status := <-result; status != "unknown" || p.StatusDetail() != "spooler_probe_timeout" {
		releaseOnce.Do(func() { close(release) })
		t.Fatalf("timeout lost its reason or retained old native reason: status=%q detail=%q", status, p.StatusDetail())
	}
	releaseOnce.Do(func() { close(release) })
	deadline := time.After(2 * time.Second)
	for {
		spoolerPreflightOwnership.Lock()
		_, active := spoolerPreflightOwnership.active[strings.ToLower(p.SpoolerName)]
		spoolerPreflightOwnership.Unlock()
		if !active {
			break
		}
		select {
		case <-deadline:
			t.Fatal("native query ownership not released after worker returned")
		case <-time.After(time.Millisecond):
		}
	}
	if p.StatusDetail() != "spooler_probe_timeout" || p.TransportObserved() {
		t.Fatalf("late native response overwrote timed-out evidence: detail=%q observed=%t", p.StatusDetail(), p.TransportObserved())
	}
}
