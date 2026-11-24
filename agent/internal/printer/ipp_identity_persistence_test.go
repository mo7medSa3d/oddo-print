package printer

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestIPPIdentityPersistenceFailurePreventsFirstPhysicalSubmission(t *testing.T) {
	var submitted, persisted atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(body) >= 8 && binary.BigEndian.Uint16(body[2:4]) == 0x000b {
			_, _ = w.Write(ippIdentityFixture(ippIdentityFixtureUUID))
			return
		}
		submitted.Add(1)
		_, _ = w.Write(ippAcceptedJobResponse(0, 3))
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "first print persistence")
	if err != nil {
		t.Fatal(err)
	}
	setter, ok := interface{}(p).(interface{ SetIdentityPersistence(func(string) error) })
	if !ok {
		t.Fatal("IPP backend has no durable identity fence before the first Print-Job")
	}
	setter.SetIdentityPersistence(func(uuid string) error {
		persisted.Add(1)
		if uuid != ippIdentityFixtureUUID {
			t.Errorf("persisted UUID %q", uuid)
		}
		return fmt.Errorf("injected durable-state failure")
	})
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
	if err == nil || OutcomeUnknown(err) || submitted.Load() != 0 || persisted.Load() == 0 {
		t.Fatalf("identity persistence failure allowed physical output: error=%v submitted=%d persisted=%d", err, submitted.Load(), persisted.Load())
	}
	setter.SetIdentityPersistence(func(uuid string) error { return nil })
	if err := p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()}); err != nil {
		t.Fatal(err)
	}
	if submitted.Load() != 1 {
		t.Fatalf("explicit second attempt submitted %d jobs", submitted.Load())
	}
}
