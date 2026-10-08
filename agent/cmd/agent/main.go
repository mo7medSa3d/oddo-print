package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kardianos/service"
	"github.com/yaseir-agent/agent/internal/agent"
	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/queue"
	"gopkg.in/natefinch/lumberjack.v2"
)

type program struct {
	configPath string

	// mu guards agent and the Start/Stop lifecycle fields below.
	//
	// The agent instance is written by the Start-owned runtime goroutine (on
	// every restart-loop iteration) and read by Stop, which the service manager
	// invokes on a different goroutine. ctx/cancel/runDone are published by
	// Start and read by Stop on the same cross-goroutine boundary, so they
	// are published under mu and consumed via locals — never touched
	// unsynchronised. Without this, Stop could observe a stale nil and skip
	// closing the SQLite queue, or observe a half-published pointer.
	// go test -race would flag it.
	mu    sync.Mutex
	agent *agent.Agent

	ctx     context.Context
	cancel  context.CancelFunc
	runDone chan struct{} // closed exactly once when the Start-owned runtime exits
}

// setAgent publishes the current agent instance.
func (p *program) setAgent(a *agent.Agent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.agent = a
}

// getAgent returns the current agent instance, if one has been created.
func (p *program) getAgent() *agent.Agent {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.agent
}

func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	p.mu.Lock()
	p.ctx, p.cancel, p.runDone = ctx, cancel, runDone
	p.mu.Unlock()
	go func() {
		defer close(runDone)

		if err := config.Ensure(p.configPath); err != nil {
			log.Printf("Failed to prepare canonical config path %s: %v — waiting for resolution...", p.configPath, err)
			<-ctx.Done()
			return
		}

		// Materialize the durable queue database on every boot, BEFORE the
		// pairing gate below. An unpaired agent idles without ever reaching
		// agent.New (which opens the queue), but first-run initialization
		// promises a ready outbox: config dir, default config, logs, AND
		// the SQLite database with its schema. The handle is closed
		// immediately; agent.New reopens the same file after pairing.
		if dbPath := config.QueueDBPath(p.configPath); dbPath != "" {
			if q, qerr := queue.New(dbPath); qerr != nil {
				log.Printf("WARNING: durable queue unavailable at %s: %v", dbPath, qerr)
			} else {
				if err := q.Close(); err != nil {
					log.Printf("WARNING: durable queue close failed at %s: %v", dbPath, err)
				}
			}
		}

		// Attempt to load and validate configuration inside the service loop.
		// If unconfigured or invalid, do not crash the service (which causes SCM 1053 / restart loops);
		// instead, log and wait quietly in an Idle / Unpaired state with
		// exponential backoff (5s doubling, capped at 60s) so a wedged
		// setup does not burn CPU or flood rotating logs. A file that
		// EXISTS but fails parsing is corruption, not absence: log it loudly
		// and idle (without spinning) until the operator fixes or deletes
		// the file or the service stops. Exiting here (e.g. log.Fatalf)
		// would terminate the process from this goroutine, skipping
		// `defer close(runDone)` and hanging Stop on its 27s bound.
		var cfg *config.Config
		backoff := 5 * time.Second
		const maxBackoff = 60 * time.Second
		for {
			var err error
			cfg, err = config.Load(p.configPath)
			if err != nil {
				if _, statErr := os.Stat(p.configPath); statErr == nil {
					log.Printf("ERROR: Agent configuration at %s is corrupt and cannot be parsed (%v) — idling without running; fix or delete the file and restart", p.configPath, err)
					<-ctx.Done()
					return
				}
				log.Printf("Agent unconfigured at %s (%v) — retrying in %s...", p.configPath, err, backoff)
			} else if cfg == nil || cfg.Agent.ID == "" || cfg.Agent.Secret == "" {
				log.Printf("Agent at %s is unpaired (missing agent id/secret) — idling in unpaired state, retrying in %s...", p.configPath, backoff)
			} else if err := cfg.Validate(); err != nil {
				log.Printf("Agent configuration invalid (%v) — idling in unpaired state, retrying in %s...", err, backoff)
			} else {
				break
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}

		// Restart loop: if the agent crashes or exits with an error, restart it
		// with exponential backoff. This ensures the agent recovers from transient
		// failures without requiring manual intervention.
		restartBackoff := 5 * time.Second
		const maxRestartBackoff = 60 * time.Second
		for {
			app, err := agent.New(cfg, p.configPath)
			if err != nil {
				log.Printf("Failed to initialize agent: %v — retrying in %s...", err, restartBackoff)
				select {
				case <-ctx.Done():
					return
				case <-time.After(restartBackoff):
				}
				restartBackoff *= 2
				if restartBackoff > maxRestartBackoff {
					restartBackoff = maxRestartBackoff
				}
				continue
			}
			p.setAgent(app)

			if err := app.Run(ctx); err != nil {
				log.Printf("Agent error: %v — restarting in %s...", err, restartBackoff)
			} else {
				log.Printf("Agent exited cleanly")
				return
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(restartBackoff):
			}
			restartBackoff *= 2
			if restartBackoff > maxRestartBackoff {
				restartBackoff = maxRestartBackoff
			}
		}
	}()
	return nil
}

// Stop is invoked by the service manager (or on Ctrl+C in interactive mode).
// It cancels the agent, waits for Run() to complete its bounded shutdown, and
// only then closes the SQLite queue so the database is never closed mid-write.
func (p *program) Stop(s service.Service) error {
	p.mu.Lock()
	cancel, runDone := p.cancel, p.runDone
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	// SCM control handling is time-bounded. Keep SQLite open until Run()
	// has returned; otherwise a late worker can touch a closed WAL-backed
	// database. runDone is closed by the Start-owned goroutine itself, so Stop
	// needs no additional waiter goroutine that could outlive the 27s boundary.
	if runDone == nil {
		return nil
	}
	select {
	case <-runDone:
		if ag := p.getAgent(); ag != nil {
			if err := ag.Close(); err != nil {
				return fmt.Errorf("close local queue: %w", err)
			}
		}
		return nil
	case <-time.After(27 * time.Second):
		// Do not close SQLite while Run() may still be using it. Windows SCM
		// gives the service-control handler about 30s; returning an error here
		// preserves database integrity at the cost of SCM escalating the stop.
		log.Printf("ERROR: service stop exceeded 27s; refusing to close local queue while agent loop is still running")
		return fmt.Errorf("agent shutdown exceeded 27s; local queue left open")
	}
}

// setupLogging opens a continuously rotating log file beside the config file
// (%PROGRAMDATA%\YaseirAgent\logs\agent.log on Windows). The agent never
// writes to Program Files; the config path is the writable runtime root.
func setupLogging(configPath string) (*lumberjack.Logger, error) {
	logDir := filepath.Dir(configPath)
	if logDir == "" || logDir == "." {
		exeDir, err := config.ExecutableDir()
		if err != nil {
			return nil, fmt.Errorf("resolve executable dir: %w", err)
		}
		logDir = exeDir
	}
	runtimeRoot := logDir
	// Establish the runtime trust root before creating any child path. If an
	// existing ProgramData root is a junction/reparse point, creating
	// <root>/logs first would already follow it before the child ACL check.
	if err := os.MkdirAll(runtimeRoot, 0700); err != nil {
		return nil, fmt.Errorf("create runtime directory %s: %w", runtimeRoot, err)
	}
	if err := config.EnsureSecureDirectoryACL(runtimeRoot); err != nil {
		return nil, fmt.Errorf("secure runtime directory %s: %w", runtimeRoot, err)
	}

	logDir = filepath.Join(runtimeRoot, "logs")
	// 0700: agent logs describe locally attached hardware and job metadata.
	if err := os.MkdirAll(logDir, 0700); err != nil {
		return nil, fmt.Errorf("create log directory %s: %w", logDir, err)
	}
	if err := config.EnsureSecureDirectoryACL(logDir); err != nil {
		return nil, fmt.Errorf("secure log directory %s: %w", logDir, err)
	}
	logPath := filepath.Join(logDir, "agent.log")
	// Existing logs/backups may predate the hardened directory ACL; repair
	// their explicit file DACLs as well. New lumberjack files inherit the
	// protected directory ACL.
	if matches, err := filepath.Glob(filepath.Join(logDir, "agent*.log*")); err == nil {
		for _, path := range matches {
			if err := config.EnsureSecureFileACL(path); err != nil {
				return nil, fmt.Errorf("secure existing log %s: %w", path, err)
			}
		}
	}

	rotator := &lumberjack.Logger{
		Filename:   logPath,
		MaxSize:    10, // 10 megabytes max size
		MaxBackups: 3,
		LocalTime:  true,
		Compress:   false,
	}

	if service.Interactive() || os.Getenv("DOCKER_CONTAINER") != "" {
		log.SetOutput(io.MultiWriter(os.Stdout, rotator))
	} else {
		log.SetOutput(rotator)
	}
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Printf("log file: %s", logPath)
	return rotator, nil
}

func stopServiceForRemoval(s service.Service) error {
	deadline := time.Now().Add(30 * time.Second)
	stopRequested := false
	for {
		status, err := s.Status()
		if err != nil {
			if serviceRemovalAlreadyComplete(err) {
				return nil
			}
			return fmt.Errorf("read service status before removal: %w", err)
		}
		if status == service.StatusStopped {
			return nil
		}
		if status == service.StatusRunning && !stopRequested {
			if err := s.Stop(); err != nil {
				if serviceRemovalAlreadyComplete(err) {
					return nil
				}
				return fmt.Errorf("stop service before removal: %w", err)
			}
			stopRequested = true
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for YaseirAgent to stop before removal")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func uninstallServiceIfPresent(s service.Service) (bool, error) {
	status, err := s.Status()
	if err != nil {
		if serviceRemovalAlreadyComplete(err) {
			return false, nil
		}
		return false, fmt.Errorf("read service status before removal: %w", err)
	}
	if status != service.StatusStopped {
		return false, fmt.Errorf("YaseirAgent must be stopped before removal")
	}
	if err := s.Uninstall(); err != nil {
		if _, statusErr := s.Status(); serviceRemovalAlreadyComplete(statusErr) {
			return false, nil
		}
		return false, fmt.Errorf("uninstall service failed: %w", err)
	}
	return true, nil
}

func handleServiceControl(rawAction, configPath string) error {
	svcConfig := &service.Config{
		Name:         "YaseirAgent",
		DisplayName:  "Yaseir Agent",
		Description:  "Local print gateway agent for Yaseir Cloud Printing Platform — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:    []string{"-config", configPath},
		Dependencies: []string{"Tcpip"},
	}
	prg := &program{configPath: configPath}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		return fmt.Errorf("failed to create service wrapper: %w", err)
	}

	action := strings.ToLower(strings.TrimSpace(rawAction))
	switch action {
	case "status", "install", "uninstall", "purge", "start", "stop", "restart":
		if err := verifyCurrentAgentServiceOwnershipIfPresent(); err != nil {
			return err
		}
	}
	switch action {
	case "status":
		status, err := s.Status()
		if err != nil {
			return fmt.Errorf("service status failed: %w", err)
		}
		switch status {
		case service.StatusRunning:
			fmt.Println("YaseirAgent service is running")
		case service.StatusStopped:
			fmt.Println("YaseirAgent service is stopped")
		default:
			fmt.Println("YaseirAgent service status is unknown")
		}
		return nil
	case "install":
		if err := purgeLegacyAgentServices(); err != nil {
			return fmt.Errorf("remove legacy Agent services before install: %w", err)
		}
		if err := s.Install(); err != nil {
			if updateErr := updateInstalledService(svcConfig); updateErr != nil {
				return fmt.Errorf("install service failed: %w; updating existing service failed: %v", err, updateErr)
			}
		}
		configureServiceRecovery(svcConfig.Name)
		fmt.Println("YaseirAgent service installed successfully")
		return nil
	case "uninstall":
		if err := stopServiceForRemoval(s); err != nil {
			return err
		}
		removed, err := uninstallServiceIfPresent(s)
		if err != nil {
			return err
		}
		if err := purgeAgentData(); err != nil {
			return err
		}
		if err := purgeLegacyAgentServices(); err != nil {
			return fmt.Errorf("remove legacy Agent services during uninstall: %w", err)
		}
		if removed {
			fmt.Println("YaseirAgent service uninstalled and all local Agent data purged successfully")
		} else {
			fmt.Println("YaseirAgent service is already uninstalled; all local Agent data was purged")
		}
		return nil
	case "purge":
		if err := stopServiceForRemoval(s); err != nil {
			return err
		}
		if _, err := uninstallServiceIfPresent(s); err != nil {
			return err
		}
		if err := purgeLegacyAgentServices(); err != nil {
			return fmt.Errorf("remove legacy Agent services during purge: %w", err)
		}
		// Service ownership/removal is the safety boundary above and remains
		// fail-closed. Runtime/cache cleanup is different: Windows can keep
		// WebView, log, AV-scanned, or profile files transiently locked even
		// after the service is gone. Do not strand the whole product because a
		// disposable data file could not be deleted. The NSIS uninstaller
		// retries the fixed ProgramData roots after this helper exits.
		if err := purgeInstallationData(); err != nil {
			log.Printf("WARNING: uninstall data cleanup incomplete; NSIS will retry after helper exit: %v", err)
			fmt.Fprintf(os.Stderr, "WARNING: uninstall data cleanup incomplete; NSIS will retry after helper exit: %v\n", err)
			fmt.Println("YaseirAgent services removed; residual local data cleanup deferred to the uninstaller")
			return nil
		}
		fmt.Println("YaseirAgent service and all local Yaseir application data purged successfully")
		return nil
	case "start":
		if err := s.Start(); err != nil {
			return fmt.Errorf("start service failed: %w", err)
		}
		fmt.Println("YaseirAgent service started successfully")
		return nil
	case "stop":
		if err := s.Stop(); err != nil {
			return fmt.Errorf("stop service failed: %w", err)
		}
		fmt.Println("YaseirAgent service stopped successfully")
		return nil
	case "restart":
		if err := s.Restart(); err != nil {
			return fmt.Errorf("restart service failed: %w", err)
		}
		fmt.Println("YaseirAgent service restarted successfully")
		return nil
	default:
		return fmt.Errorf("unknown service action: %q (expected install, uninstall, purge, start, stop, restart, status)", rawAction)
	}
}

func main() {
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	svcFlag := flag.String("service", "", "Control the system service: install, uninstall, purge, start, stop, restart, status")
	flag.Parse()

	// 1. Service control path: dispatch immediately without reading config or initializing agent
	if *svcFlag != "" {
		if err := handleServiceControl(*svcFlag, *configPath); err != nil {
			log.Fatalf("Service action %q failed: %v", *svcFlag, err)
		}
		os.Exit(0)
	}

	// 2. Normal runtime path. Enforce one runtime process per machine even
	// when the executable is launched manually or two desktop starts race.
	releaseRuntimeSingleton, err := acquireAgentRuntimeSingleton()
	if err != nil {
		log.Printf("Refusing duplicate Agent runtime: %v", err)
		return
	}
	defer releaseRuntimeSingleton()

	// Logging setup
	logRotator, err := setupLogging(*configPath)
	if err != nil {
		log.Printf("WARNING: logging unavailable: %v", err)
	} else {
		defer logRotator.Close()
	}

	log.Printf("Using config file: %s", *configPath)

	svcConfig := &service.Config{
		Name:         "YaseirAgent",
		DisplayName:  "Yaseir Agent",
		Description:  "Local print gateway agent for Yaseir Cloud Printing Platform — outbound HTTPS/WSS only, no inbound ports.",
		Arguments:    []string{"-config", *configPath},
		Dependencies: []string{"Tcpip"},
	}

	prg := &program{configPath: *configPath}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatalf("Failed to create service wrapper: %v", err)
	}

	logger, err := s.Logger(nil)
	if err != nil {
		log.Printf("WARNING: service logger unavailable: %v", err)
	}

	// Invoke service.Run() early before performing fatal configuration exits.
	// If the configuration is missing or unverified, program.Start idles in an Unpaired state
	// rather than crashing out and triggering Windows SCM Error 1053.
	err = s.Run()
	if err != nil {
		log.Printf("Service run error: %v", err)
		if logger != nil {
			if logErr := logger.Error(err); logErr != nil {
				log.Printf("service logger write failed: %v", logErr)
			}
		}
	}
}
