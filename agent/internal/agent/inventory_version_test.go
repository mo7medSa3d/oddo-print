package agent

import (
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestInventoryVersionClockRollbackAndRestartCatchup(t *testing.T) {
	var clock inventoryVersionClock
	first := clock.next(time.Unix(100, 0))
	second := clock.next(time.Unix(50, 0))
	a, _ := strconv.ParseInt(first, 10, 64)
	b, _ := strconv.ParseInt(second, 10, 64)
	if b != a+1 {
		t.Fatalf("clock rollback changed ordering: %s -> %s", first, second)
	}
	var restarted inventoryVersionClock
	if !restarted.observe(second) {
		t.Fatal("restarted clock rejected Gateway high-water mark")
	}
	next, _ := strconv.ParseInt(restarted.next(time.Unix(1, 0)), 10, 64)
	if next != b+1 {
		t.Fatalf("restart did not catch up: got %d, want %d", next, b+1)
	}
	for _, invalid := range []string{"", "-1", "01", "+1", "1e3", "9223372036854775808"} {
		if restarted.observe(invalid) {
			t.Errorf("accepted invalid version %q", invalid)
		}
	}
}

func TestInventoryVersionClockConcurrentSnapshots(t *testing.T) {
	var clock inventoryVersionClock
	const count = 100
	versions := make(chan string, count)
	var workers sync.WaitGroup
	for i := 0; i < count; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			versions <- clock.next(time.Unix(100, 0))
		}()
	}
	workers.Wait()
	close(versions)
	seen := make(map[string]bool, count)
	for version := range versions {
		if seen[version] {
			t.Fatalf("duplicate concurrent snapshot version %s", version)
		}
		seen[version] = true
	}
}

func TestHeartbeatPagesShareVersionAndNextSnapshotAdvances(t *testing.T) {
	printers := make([]map[string]interface{}, maxHeartbeatPrintersPerPage+1)
	for i := range printers {
		printers[i] = map[string]interface{}{"id": strconv.Itoa(i)}
	}
	pages := buildHeartbeatPayloadPages(printers, nil, nil, nil, true)
	if len(pages) != 2 || pages[0]["inventorySnapshotVersion"] != pages[1]["inventorySnapshotVersion"] {
		t.Fatalf("snapshot pages do not share one version: %v", pages)
	}
	next := buildHeartbeatPayloadPages(nil, nil, nil, nil, true)
	firstVersion, _ := strconv.ParseInt(pages[0]["inventorySnapshotVersion"].(string), 10, 64)
	nextVersion, _ := strconv.ParseInt(next[0]["inventorySnapshotVersion"].(string), 10, 64)
	if nextVersion <= firstVersion {
		t.Fatal("next snapshot did not advance its version")
	}
}
