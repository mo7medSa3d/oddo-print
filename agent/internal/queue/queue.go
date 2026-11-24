package queue

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/mattn/go-sqlite3"
	"github.com/yaseir-agent/agent/internal/config"
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

// ErrJobIdentityMismatch means an existing durable job ID has different
// printer ownership or payload bytes. A new claim never authorizes rewriting
// the original operation, including after a provable zero-byte failure.
var ErrJobIdentityMismatch = errors.New("local job identity differs from recorded printer or payload")

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
	// A completely fresh Windows installation has no C:\ProgramData\YaseirAgent
	// directory. Always create it before SQLite opens the database file.
	dir := filepath.Dir(dbPath)
	if dir == "" || dir == "." {
		dir = "."
	}
	// 0700: local queue rows contain print payloads (receipts, invoices).
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create queue directory %s: %w", dir, err)
	}
	// Mode bits are ignored on Windows (only the read-only flag applies), so
	// MkdirAll alone leaves the payload directory readable by any local user
	// via the inherited ProgramData DACL. Harden it like every other
	// secrets-adjacent store (config, secret store, PDF temp dirs).
	if dir != "." {
		if err := config.EnsureSecureDirectoryACL(dir); err != nil {
			return nil, fmt.Errorf("secure queue directory %s: %w", dir, err)
		}
	}
	if dbPath != ":memory:" {
		// SQLite opens its database and recovery sidecars itself. Validate every
		// pre-existing file before the first PRAGMA can follow a planted link or
		// use a child with a permissive explicit Windows DACL. Create the main
		// database privately so new POSIX sidecars inherit its 0600 mode.
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			if err := prepareQueueFile(dbPath+suffix, suffix == ""); err != nil {
				return nil, err
			}
		}
	}

	// FULL WAL commits durably fence physical execution across power loss.
	// NORMAL may lose an acknowledged printing/terminal ledger transaction.
	dsnPath := dbPath
	if dbPath != ":memory:" {
		// The SQLite driver splits DSN options at '?', even in an ordinary
		// filename. Encode the filesystem path as a file URI so it opens the
		// exact file checked above, not a truncated path with different ACLs
		// or sidecars. Resolve drive-relative Windows paths before encoding.
		absolutePath, err := filepath.Abs(dbPath)
		if err != nil {
			return nil, fmt.Errorf("resolve queue database path: %w", err)
		}
		uriPath := filepath.ToSlash(absolutePath)
		if volume := filepath.VolumeName(absolutePath); len(volume) == 2 && volume[1] == ':' {
			uriPath = "/" + uriPath
		}
		dsnPath = (&url.URL{Scheme: "file", Path: uriPath}).String()
	}
	dsn := dsnPath + "?_busy_timeout=5000&_journal_mode=WAL&_synchronous=FULL&_foreign_keys=ON&_txlock=immediate"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite handles writes best with one writer. The application continues to
	// parallelize printer work through per-printer goroutines; database access
	// is deliberately serialized to avoid SQLITE_BUSY on Windows.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	initialized := false
	defer func() {
		if !initialized {
			_ = db.Close()
		}
	}()
	for _, pragma := range []string{`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`, `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`} {
		if _, err := db.Exec(pragma); err != nil {
			return nil, fmt.Errorf("queue durability configuration %s: %w", pragma, err)
		}
	}
	var journal string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		return nil, fmt.Errorf("read queue journal mode: %w", err)
	}
	if journal != "wal" && !(dbPath == ":memory:" && journal == "memory") {
		return nil, fmt.Errorf("queue requires WAL, got %q", journal)
	}
	var synchronous int
	if err := db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		return nil, fmt.Errorf("read queue durability: %w", err)
	}
	if synchronous < 2 {
		return nil, fmt.Errorf("queue requires FULL durability, got %d", synchronous)
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin queue schema migration: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(`
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
			claim_token TEXT,
			spooler_job_id TEXT,
			execution_claim_token TEXT,
			execution_transport TEXT,
			output_evidence TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_queue_status ON print_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_queue_printer ON print_jobs(printer_id);
	`)
	if err != nil {
		return nil, err
	}

	// Inspect columns instead of swallowing ALTER errors. SQLite forbids
	// adding a CURRENT_TIMESTAMP default to an existing nonempty table.
	columns := make(map[string]bool)
	rows, err := tx.Query(`PRAGMA table_info(print_jobs)`)
	if err != nil {
		return nil, fmt.Errorf("inspect queue schema: %w", err)
	}
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, typ string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primaryKey); err != nil {
			_ = rows.Close()
			return nil, err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, column := range []struct{ name, declaration string }{
		{"last_error", "last_error TEXT"}, {"updated_at", "updated_at DATETIME"},
		{"claimed_at", "claimed_at DATETIME"}, {"claim_token", "claim_token TEXT"},
		{"spooler_job_id", "spooler_job_id TEXT"},
		{"execution_claim_token", "execution_claim_token TEXT"},
		{"execution_transport", "execution_transport TEXT"},
		{"output_evidence", "output_evidence TEXT"},
	} {
		if !columns[column.name] {
			if _, err := tx.Exec("ALTER TABLE print_jobs ADD COLUMN " + column.declaration); err != nil {
				return nil, fmt.Errorf("migrate queue column %s: %w", column.name, err)
			}
		}
	}
	if _, err := tx.Exec(`UPDATE print_jobs SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL`); err != nil {
		return nil, fmt.Errorf("backfill queue timestamps: %w", err)
	}
	if _, err := tx.Exec(`UPDATE print_jobs SET execution_claim_token = claim_token WHERE execution_claim_token IS NULL AND status IN ('printing','success','failed') AND claim_token IS NOT NULL`); err != nil {
		return nil, fmt.Errorf("retain execution claims during queue migration: %w", err)
	}
	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_queue_pending_claims ON print_jobs(status, updated_at, id) WHERE claim_token IS NOT NULL AND claim_token <> ''`); err != nil {
		return nil, fmt.Errorf("create queue pending-claims index: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit queue schema migration: %w", err)
	}
	initialized = true

	return &Queue{db: db}, nil
}

func prepareQueueFile(path string, create bool) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) && create {
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if createErr != nil {
			return fmt.Errorf("create private queue file %s: %w", path, createErr)
		}
		if err := file.Close(); err != nil {
			return fmt.Errorf("close private queue file %s: %w", path, err)
		}
		info, err = os.Lstat(path)
	} else if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect queue file %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing non-regular queue file %s", path)
	}
	if err := config.EnsureSecureFileACL(path); err != nil {
		return fmt.Errorf("secure queue file %s: %w", path, err)
	}
	return nil
}

func (q *Queue) Close() error {
	if q.db != nil {
		// Refresh planner statistics (enables partial-index selection) and truncate the WAL on clean shutdown.
		_, _ = q.db.Exec(`PRAGMA optimize`)
		_, _ = q.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
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
		`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status, updated_at) VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP)`,
		id, printerID, payload,
	)
	return err
}

// ReserveBeforeDispatch persists claim ownership without claiming that printer
// I/O has begun. A crash while this row is queued is provably pre-dispatch;
// startup recovery can return the original fenced Gateway claim. Existing
// terminal/printing rows are never changed by this reservation.
func (q *Queue) ReserveBeforeDispatch(id, printerID string, payload []byte, claimToken string) error {
	tx, err := q.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var token interface{}
	if claimToken != "" {
		token = claimToken
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status, claim_token, updated_at)
		VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)`, id, printerID, payload, token); err != nil {
		return err
	}
	// A previously failed attempt can be retried only when its physical outcome
	// was provably NOT printed. In that case, the new delivery must persist its
	// own queued claim before waiting on hardware: leaving the old failed row
	// untouched would lose the new token on crash and strand the Gateway claim.
	// Unknown outcomes retain their terminal row under every legacy policy value.
	// Success and live printing rows must never be mutated here.
	var status, storedPrinterID string
	var storedPayload []byte
	var lastErr sql.NullString
	if err := tx.QueryRow(`SELECT status, last_error, printer_id, payload FROM print_jobs WHERE id = ?`, id).
		Scan(&status, &lastErr, &storedPrinterID, &storedPayload); err != nil {
		return err
	}
	if status == "failed" {
		for _, marker := range UnknownOutcomeMarkers {
			if lastErr.Valid && strings.HasPrefix(lastErr.String, marker) {
				return tx.Commit()
			}
		}
	}
	// A claim token may be refreshed only for the original immutable operation.
	// Never overwrite a queued/zero-byte-failed row's printer or payload.
	if (status == "queued" || status == "failed") &&
		(storedPrinterID != printerID || !bytes.Equal(storedPayload, payload)) {
		return ErrJobIdentityMismatch
	}
	if status == "failed" {
		if _, err := tx.Exec(`UPDATE print_jobs
			SET status = 'queued', claim_token = ?, execution_claim_token = NULL, execution_transport = NULL, output_evidence = NULL, last_error = NULL, spooler_job_id = NULL, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'failed'`, token, id); err != nil {
			return err
		}
	} else if status == "queued" {
		if _, err := tx.Exec(`UPDATE print_jobs SET claim_token = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'queued'`, token, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type PreDispatchReturn struct {
	ID         string
	ClaimToken string
}

// PendingPreDispatchReturns is a durable hand-back outbox for received claims
// which never entered the local 'printing' phase. It can be scanned after an
// Agent crash AND after an orderly pre-dispatch cancellation. The Agent must
// exclude active in-flight jobs before returning a claim to Gateway.
func (q *Queue) PendingPreDispatchReturns(limit int) ([]PreDispatchReturn, error) {
	if limit <= 0 {
		limit = 32
	}
	rows, err := q.db.Query(`SELECT id, claim_token FROM print_jobs
		WHERE status = 'queued' AND claim_token IS NOT NULL AND claim_token <> ''
		ORDER BY updated_at ASC, id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]PreDispatchReturn, 0)
	for rows.Next() {
		var item PreDispatchReturn
		if err := rows.Scan(&item.ID, &item.ClaimToken); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// ClearPreDispatchClaim marks a claim's hand-back acknowledged. Only the exact
// still-queued claim is cleared; a concurrent physical/terminal attempt is
// never modified by this acknowledgement.
func (q *Queue) ClearPreDispatchClaim(id, token string) error {
	if token == "" {
		return fmt.Errorf("cannot clear an empty pre-dispatch claim")
	}
	_, err := q.db.Exec(`UPDATE print_jobs SET claim_token = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'queued' AND claim_token = ?`, id, token)
	return err
}

// validLocalLedgerStatus is an application-layer guard for legacy SQLite
// queue files. CREATE TABLE IF NOT EXISTS does not retrofit CHECK constraints
// onto an existing table, so the SQL schema alone is not a reliable boundary.
func validLocalLedgerStatus(status string) bool {
	switch status {
	case "queued", "printing", "success", "failed":
		return true
	default:
		return false
	}
}

// UpdateStatus sets a simple status (queued/printing/success/failed) and bumps updated_at.
func (q *Queue) UpdateStatus(id, status string) error {
	if !validLocalLedgerStatus(status) {
		return fmt.Errorf("invalid local queue status %q", status)
	}
	if status == "success" || status == "failed" {
		// Keep the execution claim token until the Gateway acknowledges the
		// terminal report. Clearing it here creates a crash window where the
		// local ledger durably knows the physical outcome but the restarted
		// Agent can no longer prove which Gateway attempt produced it.
		_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, execution_claim_token = COALESCE(execution_claim_token, claim_token), claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','printing') AND output_evidence IS NULL`, status, id)
		return err
	}
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued' AND output_evidence IS NULL`, status, id)
	return err
}

// UpdateStatusWithError records durable local evidence and retains the claim
// token until the Gateway explicitly acknowledges that terminal status.
// This is the report outbox; clearing earlier would lose replay ownership.
func (q *Queue) UpdateStatusWithError(id, status, lastErr string) error {
	if !validLocalLedgerStatus(status) {
		return fmt.Errorf("invalid local queue status %q", status)
	}
	if status == "success" || status == "failed" {
		// The terminal state is a durable outbox record for the Gateway status
		// report. Preserve claim_token until a validated terminal acknowledgement.
		_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, execution_claim_token = COALESCE(execution_claim_token, claim_token), claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','printing') AND output_evidence IS NULL`, status, lastErr, id)
		return err
	}
	_, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued' AND output_evidence IS NULL`, status, lastErr, id)
	return err
}

// UpdateTerminalWithEvidence atomically records the terminal physical outcome
// and any platform spooler identity in the local outbox. The claim token is
// deliberately retained until the Gateway acknowledges this exact report.
func (q *Queue) UpdateTerminalWithEvidence(id, status, lastErr, spoolerJobID string) error {
	return q.UpdateTerminalResult(id, status, lastErr, spoolerJobID, "", "")
}

// UpdateTerminalResult commits an invocation's result, original claim and
// optional opaque file evidence together. Clearing the report-outbox token
// after acknowledgement never erases the immutable execution identity.
// OutputEvidence is canonical, validated JSON supplied by the Agent; this
// storage boundary additionally bounds the value and rejects malformed JSON.
func (q *Queue) UpdateTerminalResult(id, status, lastErr, spoolerJobID, transport, outputEvidence string) error {
	if status != "success" && status != "failed" {
		return fmt.Errorf("terminal evidence requires success/failed status, got %q", status)
	}
	// File-output evidence no longer exists: no printer type produces
	// it, so a terminal result carrying any is invalid.
	if outputEvidence != "" {
		return fmt.Errorf("invalid terminal file evidence")
	}
	if len(transport) > 32 {
		return fmt.Errorf("invalid terminal transport")
	}
	var spoolerID interface{}
	if strings.TrimSpace(spoolerJobID) != "" {
		spoolerID = strings.TrimSpace(spoolerJobID)
	}
	var transportValue interface{}
	if transport != "" {
		transportValue = transport
	}
	// Only the live physical invocation may create a terminal result. The old
	// `output_evidence IS NULL OR ...` predicate matched *every* ordinary
	// terminal receipt (thermal/IPP/Windows normally have no JSON evidence),
	// allowing a delayed failure to overwrite a durable success, or vice versa.
	// Reconciliation reads that original result; it must never rewrite it.
	result, err := q.db.Exec(`UPDATE print_jobs SET status = ?, last_error = ?, spooler_job_id = ?,
		execution_claim_token = COALESCE(execution_claim_token, claim_token), execution_transport = ?, output_evidence = NULL,
		claimed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'printing' AND output_evidence IS NULL`,
		status, lastErr, spoolerID, transportValue, id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrTerminalState
	}
	return nil
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
		`UPDATE print_jobs SET status = 'queued', last_error = ?, claim_token = NULL, execution_claim_token = NULL, execution_transport = NULL, output_evidence = NULL, spooler_job_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'printing'`,
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
// execution path: doing so could duplicate physical output. The final bool
// argument remains accepted for API compatibility but cannot reopen an unknown
// outcome, even when an older caller supplies true. A deliberate new physical
// operation must carry its own separately authorized job identity.
//
// Returns ErrTerminalState (without touching the row) when the guard
// rejects the transition, and reports it as such so the caller re-reports
// the stored outcome instead of mistaking it for ledger unavailability
// (which would requeue the job).
func (q *Queue) BeginPrint(id, printerID string, payload []byte, claimToken string, _ bool) error {
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
		`INSERT OR IGNORE INTO print_jobs (id, printer_id, payload, status, claim_token, updated_at) VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)`,
		id, printerID, payload, insertToken,
	)
	if err != nil {
		return err
	}
	var status, storedPrinterID string
	var storedToken sql.NullString
	var lastErr sql.NullString
	var storedPayload []byte
	if err := tx.QueryRow(
		`SELECT status, claim_token, last_error, printer_id, payload FROM print_jobs WHERE id = ?`,
		id,
	).Scan(&status, &storedToken, &lastErr, &storedPrinterID, &storedPayload); err != nil {
		return err
	}

	// Success is permanently terminal; no legacy argument can reopen it.
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
		if unknown {
			return ErrTerminalState
		}
	}
	if (status == "queued" || status == "failed") &&
		(storedPrinterID != printerID || !bytes.Equal(storedPayload, payload)) {
		// Even a direct BeginPrint caller cannot bypass the earlier reservation
		// fence. Roll back without touching claim tokens, retries or evidence.
		return ErrJobIdentityMismatch
	}

	// Only queued and retryable failed rows may enter printing. The UPDATE is
	// intentionally simple: there is exactly one placeholder for each value.
	// A fresh token becomes durable at the same transaction boundary, but a
	// tokenless redelivery must never clear the stored claim: that token is
	// the execution fence and the outbox evidence, so COALESCE preserves it.
	var updateToken interface{} = nil
	if claimToken != "" {
		updateToken = claimToken
	}
	updated, err := tx.Exec(
		`UPDATE print_jobs SET status = 'printing', claim_token = COALESCE(?, claim_token), execution_claim_token = COALESCE(?, claim_token), execution_transport = NULL, output_evidence = NULL, spooler_job_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','failed')`,
		updateToken, updateToken, id,
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
func (q *Queue) ClearClaimToken(id, claimToken string) error {
	_, err := q.db.Exec(`UPDATE print_jobs SET claim_token = NULL, claimed_at = NULL WHERE id = ? AND status IN ('success', 'failed') AND claim_token = ?`, id, claimToken)
	return err
}

type TerminalReport struct {
	ID             string
	Status         string
	LastError      string
	ClaimToken     string
	SpoolerJobID   string
	Transport      string
	OutputEvidence string
}

// TerminalResultFor also reads acknowledged results. Their original execution
// claim survives outbox cleanup so a later duplicate cannot relabel the result
// as evidence for a different delivery attempt.
func (q *Queue) TerminalResultFor(id string) (TerminalReport, bool, error) {
	var result TerminalReport
	err := q.db.QueryRow(`SELECT id, status, COALESCE(last_error, ''), COALESCE(execution_claim_token, claim_token, ''),
		COALESCE(spooler_job_id, ''), COALESCE(execution_transport, ''), COALESCE(output_evidence, '')
		FROM print_jobs WHERE id = ? AND status IN ('success','failed')`, id).Scan(
		&result.ID, &result.Status, &result.LastError, &result.ClaimToken, &result.SpoolerJobID, &result.Transport, &result.OutputEvidence)
	if err == sql.ErrNoRows {
		return TerminalReport{}, false, nil
	}
	return result, err == nil, err
}

// PendingTerminalReports returns durable terminal outcomes whose Gateway
// acknowledgement has not yet been observed. These rows are a tiny local
// outbox: they allow Agent restart recovery to re-report a durable result
// without ever re-running the physical printer side effect.
func (q *Queue) PendingTerminalReports(limit int) ([]TerminalReport, error) {
	return q.pendingTerminalReports(limit, "", "", false)
}

// PendingTerminalReportsAfter provides stable keyset paging for the replay
// worker. Permanently stale claims must retain their evidence, but cannot pin
// every later outcome behind the first bounded batch forever.
func (q *Queue) PendingTerminalReportsAfter(limit int, afterID, throughID string) ([]TerminalReport, error) {
	return q.pendingTerminalReports(limit, afterID, throughID, true)
}

// PendingTerminalReportMaxID fixes the end of one replay sweep. Without it,
// continuous arrivals beyond the cursor could postpone wrap indefinitely.
func (q *Queue) PendingTerminalReportMaxID() (string, error) {
	var id string
	err := q.db.QueryRow(`SELECT COALESCE(MAX(id), '') FROM print_jobs
		WHERE status IN ('success', 'failed') AND claim_token IS NOT NULL AND claim_token <> ''`).Scan(&id)
	return id, err
}

func (q *Queue) pendingTerminalReports(limit int, afterID, throughID string, paged bool) ([]TerminalReport, error) {
	if limit <= 0 {
		limit = 32
	}
	query := `
		SELECT id, status, COALESCE(last_error, ''), claim_token, COALESCE(spooler_job_id, ''), COALESCE(execution_transport, ''), COALESCE(output_evidence, '')
		FROM print_jobs
		WHERE status IN ('success', 'failed')
		  AND claim_token IS NOT NULL
		  AND claim_token <> ''`
	args := []interface{}{}
	if paged {
		query += ` AND id > ? AND id <= ? ORDER BY id ASC LIMIT ?`
		args = append(args, afterID, throughID, limit)
	} else {
		query += ` ORDER BY updated_at ASC LIMIT ?`
		args = append(args, limit)
	}
	rows, err := q.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]TerminalReport, 0)
	for rows.Next() {
		var report TerminalReport
		if err := rows.Scan(&report.ID, &report.Status, &report.LastError, &report.ClaimToken, &report.SpoolerJobID, &report.Transport, &report.OutputEvidence); err != nil {
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
	ID           string
	PrinterID    string
	ClaimToken   string
	SpoolerJobID string
}

// MarkInterrupted moves every job still recorded as 'printing' into a terminal
// local 'failed' state carrying InterruptedMarker, and returns them.
//
// It must be called exactly once at startup, before any new job is accepted:
// a row in 'printing' after a fresh start can only mean the previous process
// died while the document was at the printer.
func (q *Queue) MarkInterrupted() ([]InterruptedJob, error) {
	rows, err := q.db.Query(`SELECT id, printer_id, COALESCE(claim_token, ''), COALESCE(spooler_job_id, '') FROM print_jobs WHERE status = 'printing'`)
	if err != nil {
		return nil, err
	}
	var found []InterruptedJob
	for rows.Next() {
		var j InterruptedJob
		if err := rows.Scan(&j.ID, &j.PrinterID, &j.ClaimToken, &j.SpoolerJobID); err != nil {
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

	var marked []InterruptedJob
	for _, j := range found {
		msg := InterruptedMarker + ": the agent stopped while this job was printing; the physical output is unknown (it may have printed fully, partially, or not at all)"
		if err := q.UpdateStatusWithError(j.ID, "failed", msg); err != nil {
			return marked, err
		}
		marked = append(marked, j)
	}
	return marked, nil
}

// RecordSpoolerJobID persists platform submission evidence observed during
// the printing phase, before the terminal write. A crash between StartDoc
// (identity allocated) and the terminal ledger write must not lose the only
// durable link to the platform job. It only touches rows still in
// 'printing': terminal evidence is written once by the terminal path and
// never overwritten by a stale observation.
func (q *Queue) RecordSpoolerJobID(id, spoolerJobID string) error {
	if strings.TrimSpace(spoolerJobID) == "" {
		return fmt.Errorf("refusing to record an empty spooler job ID for %s", id)
	}
	res, err := q.db.Exec(`UPDATE print_jobs SET spooler_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'printing'`, strings.TrimSpace(spoolerJobID), id)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("spooler job ID not recorded for %s: no printing row", id)
	}
	return nil
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
// physically ambiguous failure. Such rows are never reprinted by duplicate
// delivery, regardless of legacy configuration: the previous attempt may have
// produced paper. Reconciliation may report that original outcome only.
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
// Unused in production code but kept for potential future diagnostic endpoints.
func (q *Queue) CountByStatus(status string) (int, error) {
	var n int
	err := q.db.QueryRow(`SELECT COUNT(*) FROM print_jobs WHERE status = ?`, status).Scan(&n)
	return n, err
}
