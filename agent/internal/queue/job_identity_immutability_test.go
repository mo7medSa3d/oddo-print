package queue

import (
	"bytes"
	"database/sql"
	"errors"
	"testing"
)

// A Gateway job ID denotes one immutable original operation. Neither a new
// claim token nor a zero-byte failure authorizes different bytes or printer
// ownership under that same ID.
func TestExistingQueuedOrRetryableJobCannotChangePrinterOrPayload(t *testing.T) {
	for _, phase := range []string{"queued", "retryable_failed"} {
		for _, change := range []struct {
			name    string
			printer string
			payload []byte
		}{
			{name: "different_printer", printer: "printer-B", payload: []byte("original receipt")},
			{name: "different_payload", printer: "printer-A", payload: []byte("changed receipt")},
		} {
			t.Run(phase+"/"+change.name, func(t *testing.T) {
				q := newTestQueue(t)
				const id = "immutable-print-job"
				original := []byte("original receipt")
				if err := q.ReserveBeforeDispatch(id, "printer-A", original, "claim-original"); err != nil {
					t.Fatal(err)
				}
				if phase == "retryable_failed" {
					if err := q.BeginPrint(id, "printer-A", original, "claim-original", false); err != nil {
						t.Fatal(err)
					}
					if err := q.UpdateStatusWithError(id, "failed", "connection refused before first byte"); err != nil {
						t.Fatal(err)
					}
					if err := q.ClearClaimToken(id, "claim-original"); err != nil {
						t.Fatal(err)
					}
				}

				unchanged := func(step string) {
					t.Helper()
					var printerID, status string
					var payload []byte
					var token sql.NullString
					if err := q.db.QueryRow(`SELECT printer_id, payload, status, claim_token FROM print_jobs WHERE id = ?`, id).
						Scan(&printerID, &payload, &status, &token); err != nil {
						t.Fatal(err)
					}
					expected := "queued"
					if phase == "retryable_failed" {
						expected = "failed"
					}
					if printerID != "printer-A" || !bytes.Equal(payload, original) || status != expected ||
						(phase == "queued" && token.String != "claim-original") ||
						(phase == "retryable_failed" && token.Valid) {
						t.Fatalf("%s mutated original identity/state: printer=%q bytes=%q status=%q claim=%#v", step, printerID, payload, status, token)
					}
				}

				if err := q.ReserveBeforeDispatch(id, change.printer, change.payload, "claim-forged"); !errors.Is(err, ErrJobIdentityMismatch) {
					t.Fatalf("mismatched reservation = %v; want ErrJobIdentityMismatch", err)
				}
				unchanged("ReserveBeforeDispatch")

				if err := q.BeginPrint(id, change.printer, change.payload, "claim-forged", false); !errors.Is(err, ErrJobIdentityMismatch) {
					t.Fatalf("mismatched direct BeginPrint = %v; want ErrJobIdentityMismatch", err)
				}
				unchanged("BeginPrint")

				// A truly identical retry is still permitted after a proved
				// pre-dispatch/zero-byte failure and retains the new claim fence.
				if err := q.ReserveBeforeDispatch(id, "printer-A", original, "claim-legitimate"); err != nil {
					t.Fatalf("identical retry reservation: %v", err)
				}
				if err := q.BeginPrint(id, "printer-A", original, "claim-legitimate", false); err != nil {
					t.Fatalf("identical retry execution: %v", err)
				}
				_, status, found, err := q.Get(id)
				if err != nil || !found || status != "printing" {
					t.Fatalf("identical retry did not enter printing: status=%q found=%v err=%v", status, found, err)
				}
				if token := q.ClaimTokenFor(id); token != "claim-legitimate" {
					t.Fatalf("identical retry claim was not retained: %q", token)
				}
			})
		}
	}
}
