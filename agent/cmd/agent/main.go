package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/kardianos/service"
	"github.com/yaseir-agent/agent/internal/agent"
	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/elevation"
	"github.com/yaseir-agent/agent/internal/license"
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

// closeAgentInstance releases an agent instance's local resources. It is
// used by the restart loop so a crashed instance does not keep its SQLite
// handle open while the replacement instance is created. A failure is
// logged rather than fatal: the next start recovers durable rows, and the
// service must still be able to come back up.
func closeAgentInstance(a *agent.Agent) {
	if a == nil {
		return
	}
	if err := a.Close(); err != nil {
		log.Printf("WARNING: close local queue of the replaced agent failed: %v", err)
	}
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

		if inGrace, err := license.VerifyBundleFromEnv(); err != nil {
			log.Printf("CRITICAL: Offline license verification failed: %v — agent halted", err)
			<-ctx.Done()
			return
		} else if inGrace {
			log.Printf("WARNING: Offline license is in grace period; renew subscription soon")
		}
		guard, gErr := license.NewRuntimeGuardFromConfig(filepath.Dir(config.QueueDBPath(p.configPath)))
		if gErr != nil {
			log.Printf("CRITICAL: Invalid license public key configuration: %v — agent halted", gErr)
			<-ctx.Done()
			return
		}
		if !guard.Enforcing() && strings.TrimSpace(os.Getenv("YASEIR_DEV_ALLOW_UNLICENSED")) != "1" {
			log.Printf("WARNING: No Ed25519 license public key configured; printing is blocked (fail-closed) until YASEIR_LICENSE_PUBLIC_KEY_B64 or PinnedPublicKeyB64 is set.")
		}
		if applyErr := guard.ApplyBundleFromEnv(); applyErr != nil {
			log.Printf("CRITICAL: Offline license guard rejected bundle: %v — agent halted", applyErr)
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
			case <-time.After(jitteredBackoff(backoff)):
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
			if freshCfg, loadErr := config.Load(p.configPath); loadErr == nil && freshCfg != nil && freshCfg.Agent.ID != "" && freshCfg.Agent.Secret != "" && freshCfg.Validate() == nil {
				cfg = freshCfg
			}
			app, err := agent.New(cfg, p.configPath)
			if err != nil {
				log.Printf("Failed to initialize agent: %v — retrying in %s...", err, restartBackoff)
				select {
				case <-ctx.Done():
					return
				case <-time.After(jitteredBackoff(restartBackoff)):
				}
				restartBackoff *= 2
				if restartBackoff > maxRestartBackoff {
					restartBackoff = maxRestartBackoff
				}
				continue
			}
			p.setAgent(app)

			runStart := time.Now()
			if err := app.Run(ctx); err != nil {
				if time.Since(runStart) >= maxRestartBackoff {
					restartBackoff = 5 * time.Second
				}
				log.Printf("Agent error: %v — restarting in %s...", err, restartBackoff)
				// Release the failed instance's local SQLite handle before a
				// replacement is created. Every agent.New opens its own
				// database handle, so without this each restart would leak
				// one for the lifetime of the process. Agent.Close keeps the
				// queue open when a job handler is still in flight, which is
				// the same safety rule the service-stop path uses.
				closeAgentInstance(app)
			} else {
				log.Printf("Agent exited cleanly")
				closeAgentInstance(app)
				return
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(jitteredBackoff(restartBackoff)):
			}
			restartBackoff *= 2
			if restartBackoff > maxRestartBackoff {
				restartBackoff = maxRestartBackoff
			}
		}
	}()
	return nil
}

// jitteredBackoff adds bounded positive jitter (+0..25%) so POS terminals
// restarting after a shared outage do not reconnect in lockstep.
func jitteredBackoff(base time.Duration) time.Duration {
	spread := base / 4
	if spread <= 0 {
		return base
	}
	return base + time.Duration(rand.Int64N(int64(spread)))
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
	if configPath != "" {
		if absPath, err := filepath.Abs(configPath); err == nil {
			logDir = filepath.Dir(absPath)
		}
	}
	if logDir == "" || logDir == "." {
		logDir = filepath.Dir(config.DefaultConfigPath())
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
		if err := completeAgentUninstall(purgeLegacyAgentServices, purgeAgentData); err != nil {
			return err
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

// completeAgentUninstall coordinates owned legacy service removal and the
// deletion of data that those service processes may still be using.
func completeAgentUninstall(removeLegacyServices, purgeData func() error) error {
	if err := removeLegacyServices(); err != nil {
		return fmt.Errorf("remove legacy Agent services during uninstall: %w", err)
	}
	return purgeData()
}

// The headless PDFium capability marker makes it possible to distinguish an
// installed pre-fix service executable from a newer package, even when the
// installer and running service point to different paths. The marker is
// intentionally tied to the verified io.Discard WASM configuration.
func agentRuntimeInfo() string {
	info := fmt.Sprintf("YaseirAgent go=%s feature=pdfium-headless-stdio-v1 feature=gdi-thread-confined-v1", runtime.Version())
	// Embed the VCS revision whenever Go's build metadata provides one so
	// operators can compare the running service binary to the released source.
	if build, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range build.Settings {
			if setting.Key == "vcs.revision" && len(setting.Value) >= 12 {
				info += " revision=" + setting.Value[:12]
				break
			}
		}
	}
	return info
}

func main() {
	showVersion := flag.Bool("version", false, "Show the Agent runtime and embedded PDFium service capability")
	configPath := flag.String("config", config.DefaultConfigPath(), "Path to config file")
	svcFlag := flag.String("service", "", "Control the system service: install, uninstall, purge, start, stop, restart, status")
	elevatedRelaunch := flag.Bool("elevated-relaunch", false, "Internal: this process is the automatic elevated relaunch of a non-elevated launch")
	flag.Parse()
	if *showVersion {
		fmt.Println(agentRuntimeInfo())
		return
	}

	// 0. Administrator-only gate. An interactive launch (double-click,
	// console, or a -service control action from a normal shell) must run
	// with an elevated token: without one, the gate immediately hands
	// off to an elevated copy (the Windows UAC prompt is the only
	// prompt — there is no application dialog) and this process exits
	// before the singleton, logging, config or any service work starts.
	// The SCM-launched path reports Interactive() == false and already
	// runs as LocalSystem, so it is never gated in Session 0.
	elevation.RequireElevatedInteractive(service.Interactive(), *elevatedRelaunch)

	// 1. Service control path: dispatch immediately without reading config or initializing agent
	if *svcFlag != "" {
		if err := handleServiceControl(*svcFlag, *configPath); err != nil {
			log.Fatalf("Service action %q failed: %v", *svcFlag, err)
		}
		os.Exit(0)
	}

	// 2. Normal runtime path. Enforce one runtime process per machine even
	// when the executable is launched manually or two desktop starts race.
	// (POSIX scopes the lock to the config directory; Windows is machine-global.)
	releaseRuntimeSingleton, err := acquireAgentRuntimeSingleton(*configPath)
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

	log.Printf("%s", agentRuntimeInfo())
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
		if logRotator != nil {
			_ = logRotator.Close()
		}
		releaseRuntimeSingleton()
		os.Exit(1)
	}
}
