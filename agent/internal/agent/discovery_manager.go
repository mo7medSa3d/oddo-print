package agent

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/yaseir-agent/agent/internal/printer"
)

const defaultDiscoveryTimeout = 30 * time.Second

// discoveryScanFunc runs one discovery pass and reports incremental progress.
type discoveryScanFunc func(context.Context, printer.DiscoveryProgressFunc) printer.DiscoveryResult

// runBoundedDiscovery separates orchestration lifetime from an underlying
// discovery call that may be synchronous/uncancellable at the OS boundary.
// The caller gets a bounded result while finishedCh remains the sole signal used
// to release ownership of the worker/semaphore.
//
// An expired bound no longer discards the scan. Windows sources such as
// EnumPrintersW are synchronous and cannot be interrupted by a Go context, so a
// single slow source used to take every other source's findings down with it:
// the empty result meant nothing was persisted locally and the Gateway was told
// the session had produced zero devices. The scan now publishes progress
// snapshots, so the sources that did finish are preserved and reported as a
// partial result. Absence is still never reconciled as removal, because
// CompleteSources records exactly which sources proved an inventory.
func runBoundedDiscovery(ctx context.Context, max time.Duration, discover discoveryScanFunc) (printer.DiscoveryResult, bool, <-chan struct{}) {
	boundedCtx, cancel := context.WithTimeout(ctx, max)
	defer cancel()
	resultCh := make(chan printer.DiscoveryResult, 1)
	finishedCh := make(chan struct{})

	var (
		partialMu sync.Mutex
		partial   printer.DiscoveryResult
	)
	onProgress := func(r printer.DiscoveryResult) {
		partialMu.Lock()
		partial = r
		partialMu.Unlock()
	}

	go func() {
		defer close(finishedCh)
		resultCh <- discover(boundedCtx, onProgress)
	}()

	select {
	case result := <-resultCh:
		return result, true, finishedCh
	case <-boundedCtx.Done():
		partialMu.Lock()
		truncated := partial
		partialMu.Unlock()
		if truncated.Printers == nil {
			// No source had produced anything yet: nothing was learned, so
			// there is no partial inventory to report.
			return printer.DiscoveryResult{}, false, finishedCh
		}
		truncated.Truncated = true
		truncated.Errors = append(truncated.Errors,
			fmt.Sprintf("discovery exceeded the %s bound; the result is partial and absence was not reconciled as removal", max))
		// Report as a bounded (not failed) run so the partial inventory is
		// persisted and published instead of thrown away.
		return truncated, true, finishedCh
	}
}

// discoveryForceReleaseAfter bounds how long a finished-or-timed-out scan
// may pin the one-scan semaphore while its worker is stuck in synchronous,
// uncancellable OS I/O. Past this point the slot is recycled for new
// sessions; the stuck worker's late finish releases nothing.
const discoveryForceReleaseAfter = 5 * time.Minute

// discoveryMaxAbandonedScans bounds how many scans may be abandoned in
// uncancellable OS I/O before discovery stops recycling the semaphore.
//
// A force-release recycles the slot so a successor scan can proceed, but the
// abandoned worker is still blocked in the OS call and cannot be killed. Each
// force-release therefore abandons one goroutine for the lifetime of the
// process. Without a cap, a permanently wedged driver (a USB printer that
// stops answering) leaks one goroutine every force-release window, forever.
//
// The first abandonment is recovered: the slot is recycled and discovery
// continues. After the cap, the slot is deliberately NOT recycled, so no
// further scan can start and no further goroutine can be abandoned. Discovery
// for that agent stays blocked until it is restarted, which is the same
// operator-visible state the wedge already produced, but with a bounded
// resource footprint instead of an unbounded one.
const discoveryMaxAbandonedScans = 2

// releaseDiscoverySemaphoreWhenFinished transfers semaphore cleanup to a
// waiter with a watchdog. The underlying detector may be stuck in
// synchronous OS I/O that cannot be cancelled by a Go context; holding the
// semaphore prevents overlapping scans. The watchdog guarantees one wedged
// scan cannot pin discovery forever, and the generation fence guarantees
// the late finisher can never release a successor scan's slot.
func (a *Agent) releaseDiscoverySemaphoreWhenFinished(finished <-chan struct{}, forceAfter ...time.Duration) {
	bound := discoveryForceReleaseAfter
	if len(forceAfter) > 0 && forceAfter[0] > 0 {
		bound = forceAfter[0]
	}
	gen := a.discoveryGen.Add(1)
	go func(myGen uint64) {
		timer := time.NewTimer(bound)
		defer timer.Stop()
		select {
		case <-finished:
			// A force-release already recycled this slot for a successor:
			// releasing again would free a slot we no longer own.
			if a.discoveryGen.Load() != myGen {
				return
			}
			<-a.discoverySem
		case <-timer.C:
			if a.discoveryGen.CompareAndSwap(myGen, myGen+1) {
				// Publish wedged before releasing ownership: a successor can
				// acquire the slot immediately and must observe the new state.
				a.discoveryWedged.Store(true)
				// Abandoning a worker means leaking its goroutine for the
				// lifetime of the process. Cap how many scans may be
				// abandoned so a permanently wedged driver cannot leak one
				// goroutine per force-release window, forever.
				if a.discoveryAbandoned.Add(1) > discoveryMaxAbandonedScans {
					// Do NOT recycle the slot. No successor scan can start,
					// so no further goroutine can be abandoned. Discovery
					// stays blocked until restart, which is the state the
					// wedge already caused, now with a bounded footprint.
					log.Printf("[discovery] WARNING: scan wedged past %s and %d scans are already abandoned; semaphore NOT force-released to bound the leaked goroutines (restart the agent to retry discovery)", bound, a.discoveryAbandoned.Load()-1)
					return
				}
				<-a.discoverySem
				log.Printf("[discovery] WARNING: scan wedged past %s; semaphore force-released, late finish will not free another slot", bound)
			}
		}
	}(gen)
}

func boundedDiscoveryText(value string, max int) string {
	units := 0
	for index, r := range value {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if units+n > max {
			return value[:index]
		}
		units += n
	}
	return value
}
