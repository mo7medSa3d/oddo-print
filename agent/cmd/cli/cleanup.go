package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/queue"
)

// init handles the maintenance-only `jobs cleanup` command before the legacy
// flag-based CLI parser runs. The existing CLI binary is already bundled with
// the Desktop Manager, so cleanup does not require shipping another binary.
func init() {
	configPath, jsonOutput, includeUnknown, ok, err := parseCleanupArgs(os.Args[1:])
	if !ok {
		return
	}
	if err != nil {
		fatalCleanup(err.Error())
	}

	dbPath := config.QueueDBPath(configPath)
	deleted, purged, remainingUnknown, err := cleanupJobs(dbPath, includeUnknown)
	if err != nil {
		fatalCleanup(fmt.Sprintf("cleanup failed: %v", err))
	}

	if jsonOutput {
		payload, err := json.Marshal(struct {
			Deleted       int `json:"deleted"`
			UnknownPurged int `json:"unknownPurged"`
			UnknownKept   int `json:"unknownKept"`
		}{Deleted: deleted, UnknownPurged: purged, UnknownKept: remainingUnknown})
		if err != nil {
			fatalCleanup(fmt.Sprintf("encode cleanup result: %v", err))
		}
		fmt.Println(string(payload))
	} else if includeUnknown {
		fmt.Printf("Removed %d provably terminal and %d reconciled unknown-outcome local print jobs. %d unacknowledged unknown-outcome record(s) were KEPT pending Gateway reconciliation.\n", deleted, purged, remainingUnknown)
	} else {
		fmt.Printf("Removed %d provably terminal local print jobs. %d unknown-outcome record(s) were KEPT: verify the printer, then re-run with --include-unknown once reconciled.\n", deleted, remainingUnknown)
	}
	os.Exit(0)
}

// parseCleanupArgs accepts both documented forms:
//
//	jobs cleanup --config <path>
//	--config <path> jobs cleanup
//
// Global flags may therefore appear before or after the maintenance command,
// while unrelated commands are left to the normal CLI parser. Once an exact
// `jobs cleanup` command is recognized, unsupported arguments are rejected:
// this operation deletes data and cannot silently ignore a `--dry-run` typo.
// This remains independent of flag package positional-argument behavior.
func parseCleanupArgs(args []string) (configPath string, jsonOutput, includeUnknown, matched bool, err error) {
	configPath = config.DefaultConfigPath()
	positionals := make([]string, 0, 2)
	configSeen := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json", "-json":
			jsonOutput = true
		case "--include-unknown":
			includeUnknown = true
		case "--config", "-config":
			if configSeen || i+1 >= len(args) || args[i+1] == "" || strings.HasPrefix(args[i+1], "-") {
				// A malformed config flag must not turn an accidental
				// destructive invocation into an operation on the default DB.
				return "", false, false, true, fmt.Errorf("--config requires one non-empty path")
			}
			configSeen = true
			configPath = args[i+1]
			i++
		default:
			positionals = append(positionals, args[i])
		}
	}
	if len(positionals) >= 2 && positionals[0] == "jobs" && positionals[1] == "cleanup" {
		if len(positionals) != 2 {
			return "", false, false, true, fmt.Errorf("jobs cleanup received unsupported arguments: %v", positionals[2:])
		}
		return configPath, jsonOutput, includeUnknown, true, nil
	}
	return "", false, false, false, nil
}

// cleanupJobs removes provably terminal rows, and only when explicitly
// asked (the operator has physically reconciled the output) the rows whose
// physical outcome is unknown. Returns (deleted, unknownPurged, unknownKept, err).
func cleanupJobs(dbPath string, includeUnknown bool) (int, int, int, error) {
	// Ensure the parent directory exists first: a missing data dir must
	// yield an empty result, not a sqlite "unable to open" failure, and
	// this also covers fresh machines where the agent never ran.
	if dir := filepath.Dir(dbPath); dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return 0, 0, 0, fmt.Errorf("create queue directory %s: %w", dir, err)
		}
	}
	q, err := queue.New(dbPath)
	if err != nil {
		return 0, 0, 0, err
	}
	defer q.Close()
	deleted, err := q.CleanupTerminal(0)
	if err != nil {
		return 0, 0, 0, err
	}
	kept, err := q.CountOutcomeUnknown()
	if err != nil {
		return deleted, 0, 0, err
	}
	if includeUnknown && kept > 0 {
		purged, err := q.PurgeOutcomeUnknown()
		if err != nil {
			return deleted, 0, kept, err
		}
		// The operator flag may only delete ACKNOWLEDGED records. Pending
		// unknown-outcome reports remain in the durable outbox and must be
		// counted accurately, not reported as zero after a partial purge.
		remaining, err := q.CountOutcomeUnknown()
		if err != nil {
			return deleted, purged, kept, err
		}
		return deleted, purged, remaining, nil
	}
	return deleted, 0, kept, nil
}

func fatalCleanup(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
