package queue

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

// ErrTerminalState is returned by BeginPrint when the local ledger holds a
// terminal ('success') or unknown-outcome ('failed' + marker) record that
// the requested transition may not legally reopen. Callers must treat it as
// "this job already has a durable physical outcome; re-report it" and must
// NOT confuse it with ledger unavailability (which requeues).
var ErrTerminalState = errors.New("local ledger state is terminal; refusing to reopen for printing")

// ErrAlreadyPrinting means this exact claim token already owns a local printing
// attempt. A duplicate delivery must be ignored, not treated as a new physical
// print attempt.
var ErrAlreadyPrinting = errors.New("local ledger already printing this claim; duplicate dispatch suppressed")

// Queue is the Agent's local durable delivery queue. It is distinct from the
// Gateway's PostgreSQL job table:
//
//	Gateway PG: queued → claimed (lease) → printing → success/failed/expired  (cloud ownership)
//	Agent SQLite: queued → printing → success/failed                          (local execution)
//
// The local record id == Gateway job_id for correlation. The local queue
// survives agent crashes, Windows restarts, and network outages via WAL.
type Queue struct {
	db *sql.DB
}

func New(dbPath string) (*Queue, error) {
	if dbPath == "" {
		return nil, fmt.Errorf("queue db path is empty")
	}
	// A completely fresh Windows installation has no C:\ProgramData\YasserAgent
	// directory. Always create it before SQLite opens the database file.
	dir := filepath.Dir(dbPath)
	if dir == "" || dir == "." {
		dir = "."
	}
	// 0700: local queue rows contain print payloads (receipts, invoices).
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create queue directory %s: %w", dir, err)
	}

	// _busy_timeout + WAL + synchronous=NORMAL are required for crash safety
	// on Windows without blocking the per-printer serialization mutex.
	dsn := fmt.Sprintf("%s?_busy_timeout=5000&_journal_mode=WAL&_synchronous=NORMAL", dbPath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite handles writes best with one writer. The application continues to
	// parallelize printer work through per-printer goroutines; database access
	// is deliberately serialized to avoid SQLITE_BUSY on Windows.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	// Ensure WAL is actually on (some sqlite builds ignore dsn params).
	// Non-fatal: the queue still works in rollback-journal mode, but a failed
	// PRAGMA must remain visible for diagnosis rather than becoming silent.
	for _, pragma := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=NORMAL`,
		`PRAGMA busy_timeout=5000`,
	} {
		if _, err := db.Exec(pragma); err != nil {
			log.Printf("queue SQLite pragma failed (%s): %v", pragma, err)
		}
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS print_jobs (
			id TEXT PRIMARY KEY,
			printer_id TEXT NOT NULL,
			payload BLOB NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('queued','printing','success','failed')),
			retries INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			claimed_at DATETIME,
			claim_token TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_queue_status ON print_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_queue_printer ON print_jobs(printer_id);
	`)
	if err != nil {
		return nil, err
	}

	// Migrate legacy schema from Phase 0 (had only id,printer_id,payload,status,retries,created_at)
	// Add missing columns if they don't exist (ALTER TABLE ADD COLUMN IF NOT EXISTS is sqlite 3.35+)
	for _, col := range []string{
		`ALTER TABLE print_jobs ADD COLUMN last_error TEXT`,
		`ALTER TABLE print_jobs ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
		`ALTER TABLE print_jobs ADD COLUMN claimed_at DATETIME`,
		`ALTER TABLE print_jobs ADD COLUMN claim_token TEXT`,
	} {
		if _, err := db.Exec(col); err != nil {
			message := strings.ToLower(err.Error())
			if !strings.Contains(message, "duplicate column name") {
				log.Printf("queue SQLite legacy migration failed (%s): %v", col, err)
			}
		}
	}

	return &Queue{db: db}, nil
}

func (q *Queue) Close() error {
	if q.db != nil {
		return q.db.Close()
	}
	return nil
}

func (q *Queue) IsProcessed(id string) bool {
	var count int
	err := q.db.QueryRow("SELECT COUNT(*) FROM print_jobs WHERE id = ? AND status = 'success'", id).Scan(&count)
	return err == nil && count > 0
}

// Push inserts a new job idempotently; duplicate ids are ignored (insert-or-ignore)
// so that a retried Gateway delivery never causes a second physical print.
func (q *Queue) Push(id, printerID string, payload []byte) error {
	_, err := q.db.Exec(
		`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status) VALUES (?, ?, ?, 'queued')`,
		id, printerID, payload,
	)
	return err
}

// UpdateStatus sets a simple status (queued/printing/success/failed) and bumps updated_at.
func (q *Queue) UpdateStatus(id, status string) error {
	if status == "success" || status == "failed" {
		// Keep the execution claim token until the Gateway acknowledges the
		// terminal report. Clearing it here creates a crash window where the
		// local ledger durably knows the physical outcome but the restarted
		// Agent can no longer prove which Gateway attempt produced it.
		_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, id)
		return err
	}
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, id)
	return err
}

// UpdateStatusWithError also records last_error. Terminal local outcomes no
// longer need the Gateway execution credential: clear it at the same durable
// state transition. MarkInterrupted reads the token before calling this
// helper, so crash recovery can still report the preserved token to Gateway.
func (q *Queue) UpdateStatusWithError(id, status, lastErr string) error {
	if status == "success" || status == "failed" {
		// The terminal state is a durable outbox record for the Gateway status
		// report. Preserve claim_token until that report receives a 2xx response.
		_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, lastErr, id)
		return err
	}
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, lastErr, id)
	return err
}

// AbortPrint rolls a 'printing' ledger row back to 'queued' when the attempt
// is cancelled BEFORE any byte reached hardware (currently: the gateway
// rejected our claim at the fence, so another attempt owns the job).
//
// This is the inverse of BeginPrint and exists for crash-safety honesty: a
// row left in 'printing' would be misread by MarkInterrupted after a restart
// as "may have printed", permanently blocking legitimate redelivery. Aborting
// clears the superseded claim token as well, so crash recovery never reports
// with a dead token. The status predicate keeps this from clobbering a row
// that concurrently reached a terminal state.
func (q *Queue) AbortPrint(id, reason string) error {
	_, err := q.db.Exec(
		`UPDATE print_jobs SET status = 'queued', last_error = ?, claim_token = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'printing'`,
		reason, id,
	)
	return err
}

// BeginPrint records the durable local ledger entry for a delivery attempt
// and marks it as physically printing. It MUST succeed before any byte is
// sent to hardware: if the local ledger cannot be written, the agent cannot
// later prove whether this job printed, so dispatch is refused pre-dispatch
// (safe, no bytes sent) with ErrLedgerUnavailable.
//
// STATE SAFETY (primitive level, not caller convention): BeginPrint may
// only ever move a row INTO 'printing' from a non-terminal state. A local
// record whose physical outcome is terminal ('success') or unknown/ambiguous
// ('failed' carrying an unknown-outcome marker) is NEVER reopened by the
// normal path: doing so would reprint a document whose previous attempt may
// already have produced paper. The only sanctioned reopen of a marked
// unknown row is the explicit, opt-in `reprint_after_crash` behavior,
// surfaced here as allowUnknownReprint (and the caller only sets it from the
// operator's documented configuration). A success row is never reopened
// under any setting; the gateway treats success as terminal.
//
// Returns ErrTerminalState (without touching the row) when the guard
// rejects the transition, and reports it as such so the caller re-reports
// the stored outcome instead of mistaking it for ledger unavailability
// (which would requeue the job).
func (q *Queue) BeginPrint(id, printerID string, payload []byte, claimToken string, allowUnknownReprint bool) error {
	// Keep the state machine explicit instead of dynamically concatenating SQL
	// guards. The transaction is the local ownership fence: SQLite permits only
	// one writer because Queue uses a single DB connection.
	tx, err := q.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// A first delivery creates the durable ledger row before any hardware I/O.
	// Do not use the incoming token as an authorization decision yet; the row
	// state below is authoritative for both fresh and redelivered jobs.
	insertToken := interface{}(nil)
	if claimToken != "" {
		insertToken = claimToken
	}
	_, err = tx.Exec(
		`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status, claim_token) VALUES (?, ?, ?, 'queued', ?)`,
		id, printerID, payload, insertToken,
	)
	if err != nil {
		return err
	}
	var status string
	var storedToken sql.NullString
	var lastErr sql.NullString
	if err := tx.QueryRow(
		`SELECT status, claim_token, last_error FROM print_jobs WHERE id = ?`,
		id,
	).Scan(&status, &storedToken, &lastErr); err != nil {
		return err
	}

	// A success row is permanently terminal. This check deliberately precedes
	// allowUnknownReprint: operator reprint can only reopen an explicitly
	// unknown failed outcome, never a proven success.
	if status == "success" {
		return ErrTerminalState
	}

	if status == "printing" {
		// A live physical attempt owns this row. Even when the duplicate delivery
		// carries the exact same claim token, the local ledger is already in the
		// physical-execution phase. Returning nil here would let the caller enter
		// the printer path a second time. Duplicate delivery is therefore an
		// explicit no-op signal, not successful admission.
		stored := storedToken.String
		if (stored != "" && stored == claimToken) || (stored == "" && claimToken == "") {
			if err := tx.Commit(); err != nil {
				return err
			}
			return ErrAlreadyPrinting
		}
		return ErrTerminalState
	}

	if status == "failed" {
		unknown := false
		if lastErr.Valid {
			for _, marker := range UnknownOutcomeMarkers {
				if strings.HasPrefix(lastErr.String, marker) {
					unknown = true
					break
				}
			}
		}
		if unknown && !allowUnknownReprint {
			return ErrTerminalState
		}
	}

	// Only queued and retryable failed rows may enter printing. The UPDATE is
	// intentionally simple: there is exactly one placeholder for each value.
	// A fresh token becomes durable at the same transaction boundary.
	var updateToken interface{} = nil
	if claimToken != "" {
		updateToken = claimToken
	}
	updated, err := tx.Exec(
		`UPDATE print_jobs SET status = 'printing', claim_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','failed')`,
		updateToken, id,
	)
	if err != nil {
		return err
	}
	rows, err := updated.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return ErrTerminalState
	}
	return tx.Commit()
}

// ClaimTokenFor returns the claim token recorded for the most recent local
// attempt of a job (used by crash recovery to report with its own token).
func (q *Queue) ClaimTokenFor(id string) string {
	var tok sql.NullString
	if err := q.db.QueryRow(`SELECT claim_token FROM print_jobs WHERE id = ?`, id).Scan(&tok); err != nil {
		return ""
	}
	return tok.String
}

// ClearClaimToken acknowledges that the Gateway accepted a terminal status
// for this local execution attempt. The token is cleared only after the
// remote 2xx response, so a process crash between local terminalization and
// remote acknowledgement leaves a durable retryable report in SQLite.
func (q *Queue) ClearClaimToken(id string) error {
	_, err := q.db.Exec(`UPDATE print_jobs SET claim_token = NULL, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('success', 'failed')`, id)
	return err
}

type TerminalReport struct {
	ID         string
	Status     string
	LastError  string
	ClaimToken string
}

// PendingTerminalReports returns durable terminal outcomes whose Gateway
// acknowledgement has not yet been observed. These rows are a tiny local
// outbox: they allow Agent restart recovery to re-report a proven outcome
// without ever re-running the physical printer side effect.
func (q *Queue) PendingTerminalReports(limit int) ([]TerminalReport, error) {
	if limit <= 0 {
		limit = 32
	}
	rows, err := q.db.Query(`
		SELECT id, status, COALESCE(last_error, ''), claim_token
		FROM print_jobs
		WHERE status IN ('success', 'failed')
		  AND claim_token IS NOT NULL
		  AND claim_token <> ''
		ORDER BY updated_at ASC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]TerminalReport, 0)
	for rows.Next() {
		var report TerminalReport
		if err := rows.Scan(&report.ID, &report.Status, &report.LastError, &report.ClaimToken); err != nil {
			return nil, err
		}
		result = append(result, report)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns the local record for a gateway job id, if present.
func (q *Queue) Get(id string) (printerID string, status string, found bool, err error) {
	err = q.db.QueryRow(`SELECT printer_id, status FROM print_jobs WHERE id = ?`, id).Scan(&printerID, &status)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return printerID, status, true, nil
}

// InterruptedMarker prefixes the local last_error of a job that was still
// physically printing when the agent process stopped. The physical outcome of
// such a job is UNKNOWN: the printer may have printed everything, part of the
// document, or nothing at all. The marker makes that ambiguity explicit
// instead of letting the job look like an ordinary transient failure.
const InterruptedMarker = "AGENT_RESTART_DURING_PRINT"

// InterruptedJob is a job that was left mid-print by a crash/restart.
type InterruptedJob struct {
	ID         string
	PrinterID  string
	ClaimToken string
}

// MarkInterrupted moves every job still recorded as 'printing' into a terminal
// local 'failed' state carrying InterruptedMarker, and returns them.
//
// It must be called exactly once at startup, before any new job is accepted:
// a row in 'printing' after a fresh start can only mean the previous process
// died while the document was at the printer.
func (q *Queue) MarkInterrupted() ([]InterruptedJob, error) {
	rows, err := q.db.Query(`SELECT id, printer_id, COALESCE(claim_token, '') FROM print_jobs WHERE status = 'printing'`)
	if err != nil {
		return nil, err
	}
	var found []InterruptedJob
	for rows.Next() {
		var j InterruptedJob
		if err := rows.Scan(&j.ID, &j.PrinterID, &j.ClaimToken); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, j)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, j := range found {
		msg := InterruptedMarker + ": the agent stopped while this job was printing; the physical output is unknown (it may have printed fully, partially, or not at all)"
		if err := q.UpdateStatusWithError(j.ID, "failed", msg); err != nil {
			return found, err
		}
	}
	return found, nil
}

// UnknownOutcomeMarkers lists the local last_error prefixes whose physical
// outcome is ambiguous. It must stay equal to the gateway's
// PHYSICAL_OUTCOME_UNKNOWN_MARKERS (src/lib/job-status.ts) and to
// printer.OutcomeMarkers (agent/internal/printer/outcome.go) — tests on both
// sides lock the values. AGENT_RESTART_DURING_PRINT is queue.InterruptedMarker.
// The full canonical list is kept here (not just the markers this package
// writes today) so a future local writer of any ambiguous marker is refused
// reprint by WasOutcomeUnknown instead of being misclassified as safely
// retryable.
var UnknownOutcomeMarkers = []string{
	"AGENT_EXECUTION_TIMEOUT",
	"AGENT_RESTART_DURING_PRINT",
	"JOB_EXPIRED_DURING_PRINT",
	"UNKNOWN_PARTIAL_DELIVERY",
	"UNKNOWN_SUBMISSION_OUTCOME",
}

// WasOutcomeUnknown reports whether the local record for id carries a
// physically ambiguous failure. Such rows are never reprinted by a duplicate
// delivery unless reprint_after_crash is explicitly enabled: the previous
// attempt may have produced paper.
func (q *Queue) WasOutcomeUnknown(id string) bool {
	var status string
	var lastErr sql.NullString
	if err := q.db.QueryRow(`SELECT status, last_error FROM print_jobs WHERE id = ?`, id).Scan(&status, &lastErr); err != nil {
		return false
	}
	if status != "failed" || !lastErr.Valid {
		return false
	}
	for _, marker := range UnknownOutcomeMarkers {
		if strings.HasPrefix(lastErr.String, marker) {
			return true
		}
	}
	return false
}

// WasInterrupted reports whether the local record for id is the terminal
// failure produced by MarkInterrupted (i.e. a crash during physical printing).
func (q *Queue) WasInterrupted(id string) bool {
	var lastErr sql.NullString
	if err := q.db.QueryRow(`SELECT last_error FROM print_jobs WHERE id = ?`, id).Scan(&lastErr); err != nil {
		return false
	}
	return lastErr.Valid && strings.HasPrefix(lastErr.String, InterruptedMarker)
}

// CountByStatus is a small diagnostic helper for the Tauri/desktop health view.
func (q *Queue) CountByStatus(status string) (int, error) {
	var n int
	err := q.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status = ?`, status).Scan(&n)
	return n, err
}

// LastError returns the recorded failure reason for a job, if any. It is used
// when a duplicate delivery of an already-failed job must be re-reported to
// the gateway with its real terminal error instead of being printed again.
func (q *Queue) LastError(id string) string {
	var lastErr sql.NullString
	if err := q.db.QueryRow(`SELECT last_error FROM print_jobs WHERE id = ?`, id).Scan(&lastErr); err != nil {
		return ""
	}
	if !lastErr.Valid {
		return ""
	}
	return lastErr.String
}
