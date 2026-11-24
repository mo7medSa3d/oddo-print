package agent

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

type pollBrokenReader struct {
	read bool
}

func (r *pollBrokenReader) Read(p []byte) (int, error) {
	if !r.read {
		r.read = true
		return copy(p, `[{"id":"one"}]`), nil
	}
	return 0, errors.New("network read failed")
}

func TestDecodeBoundedPollJobsRejectsUntrustedSuffixesWithoutDispatch(t *testing.T) {
	base := `[{"id":"one"}]`
	for name, body := range map[string]string{
		"invalid trailing bytes":    base + "BROKEN",
		"second JSON value":         base + `{"id":"two"}`,
		"too much trailing padding": base + strings.Repeat(" ", 512),
		"truncated JSON":            `[{"id":"one"}`,
		"wrong top-level type":      `{"id":"one"}`,
		"null top-level":            `null`,
		"null array element":        `[null]`,
	} {
		t.Run(name, func(t *testing.T) {
			if jobs, err := decodeBoundedPollJobs(strings.NewReader(body), 256, 20); err == nil {
				t.Fatalf("invalid Gateway batch accepted: %d jobs", len(jobs))
			}
		})
	}
	if _, err := decodeBoundedPollJobs(&pollBrokenReader{}, 256, 20); err == nil {
		t.Fatal("network failure after valid prefix was treated as a full batch")
	}
}

func TestDecodeBoundedPollJobsEnforcesExactLimitsAndAcceptsValidBatches(t *testing.T) {
	base := `[{"id":"one"}]`
	for _, body := range []string{base, " \n" + base + " \t\r\n", "[]"} {
		jobs, err := decodeBoundedPollJobs(strings.NewReader(body), int64(len(body)), 20)
		if err != nil {
			t.Fatalf("valid batch rejected: %v", err)
		}
		if len(jobs) > 1 {
			t.Fatalf("unexpected jobs: %#v", jobs)
		}
	}
	jobs, err := decodeBoundedPollJobs(strings.NewReader(base), int64(len(base)), 1)
	if err != nil || len(jobs) != 1 || jobs[0]["id"] != "one" {
		t.Fatalf("single job at exact boundary failed: jobs=%v err=%v", jobs, err)
	}
	if _, err := decodeBoundedPollJobs(strings.NewReader(base), int64(len(base)-1), 20); err == nil {
		t.Fatal("valid JSON truncated by byte budget was accepted")
	}
	if _, err := decodeBoundedPollJobs(strings.NewReader(`[{"id":"one"},{"id":"two"}]`), 256, 1); err == nil {
		t.Fatal("too many jobs in polling batch were accepted")
	}
}

var _ io.Reader = (*pollBrokenReader)(nil)

// A buggy Gateway can return a very large array of tiny objects within the
// byte budget. Reject the (maxJobs+1)th object BEFORE allocating and decoding
// thousands more. The Agent must not dispatch a partial batch either way.
type meteredGatewayReader struct {
	reader    io.Reader
	bytesRead int
}

func (r *meteredGatewayReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.bytesRead += n
	return n, err
}
func TestDecodeBoundedGatewayListRejectsExcessiveArrayBeforeMaterialization(t *testing.T) {
	body := "[" + strings.Repeat(`{"id":"one"},`, 25000) + `{"id":"last"}]`
	reader := &meteredGatewayReader{reader: strings.NewReader(body)}
	jobs, err := decodeBoundedGatewayList(reader, int64(len(body)), 20)
	if err == nil || len(jobs) != 0 {
		t.Fatalf("oversized batch not rejected atomically: %d jobs, %v", len(jobs), err)
	}
	// Decoder read-ahead is allowed, but no need to read the entire bulk
	// response just to reject the 21st entry.
	if reader.bytesRead > 8192 {
		t.Fatal(fmt.Sprintf("oversized array read %d bytes before rejection", reader.bytesRead))
	}
	t.Logf("oversized array rejected after reading %d bytes (full response %d bytes)", reader.bytesRead, len(body))
}
