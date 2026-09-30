package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/yasser-agent/agent/internal/config"
	"github.com/yasser-agent/agent/internal/printer"
)

// handleDiagnosePrinters implements `yasser-agent diagnose printers`.
// Human-readable and JSON output. No secrets, tokens, or document payloads.
func handleDiagnosePrinters(configPath string) {
	loaded := loadConfigForCLI(configPath)
	registryPath := config.RegistryPath(loaded.path)
	report := buildDiagnosticReport(loaded.cfg, registryPath)

	jsonOutput := false
	for _, arg := range os.Args {
		if arg == "--json" || arg == "-json" {
			jsonOutput = true
			break
		}
	}
	if jsonOutput {
		out, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to encode diagnostic report: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(out))
		return
	}
	printDiagnosticReport(report)
}

type DiagnosticReport struct {
	GeneratedAt string        `json:"generated_at"`
	System      SystemInfo    `json:"system"`
	Spooler     SpoolerInfo   `json:"spooler"`
	Queues      []QueueInfo   `json:"queues"`
	Ports       []PortInfo    `json:"ports"`
	Devices     []DeviceInfo  `json:"devices"`
	Transport   TransportInfo `json:"transport"`
	Agent       AgentDiagInfo `json:"agent"`
	Jobs        []JobDiagInfo `json:"jobs"`
	Errors      []string      `json:"errors,omitempty"`
}

type SystemInfo struct {
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Architecture  string `json:"architecture"`
	DataDirectory string `json:"data_directory"`
}

type SpoolerInfo struct {
	Note string `json:"note"`
}

type QueueInfo struct {
	Name                 string `json:"name"`
	Driver               string `json:"driver"`
	Port                 string `json:"port"`
	Status               string `json:"status"`
	ConnectionType       string `json:"connection_type"`
	Protocol             string `json:"protocol"`
	Classification       string `json:"classification,omitempty"`
	ClassificationReason string `json:"classification_reason,omitempty"`
	SpoolerVerdict       string `json:"spooler_verdict,omitempty"`
	SpoolerVerdictReason string `json:"spooler_verdict_reason,omitempty"`
	SpoolerWorkOffline   bool   `json:"spooler_work_offline,omitempty"`
	SpoolerStatusFlags   uint32 `json:"spooler_status_flags,omitempty"`
	SpoolerPendingJobs   uint32 `json:"spooler_pending_jobs,omitempty"`
	SpoolerOpenOK        bool   `json:"spooler_open_ok,omitempty"`
	SpoolerOpenError     string `json:"spooler_open_error,omitempty"`
	SpoolerGetOK         bool   `json:"spooler_get_ok,omitempty"`
	SpoolerGetError      string `json:"spooler_get_error,omitempty"`
}

type PortInfo struct {
	Name string `json:"name"`
}

type DeviceInfo struct {
	Name           string `json:"name"`
	ConnectionType string `json:"connection_type"`
	VID            string `json:"vid,omitempty"`
	PID            string `json:"pid,omitempty"`
	Serial         string `json:"serial,omitempty"`
	DevicePath     string `json:"device_path,omitempty"`
	Manufacturer   string `json:"manufacturer,omitempty"`
	Status         string `json:"status"`
}

type TransportInfo struct {
	GatewayURL        string `json:"gateway_url"`
	HeartbeatInterval string `json:"heartbeat_interval"`
}

type AgentDiagInfo struct {
	AgentID      string `json:"agent_id"`
	AgentName    string `json:"agent_name"`
	Paired       bool   `json:"paired"`
	PrinterCount int    `json:"printer_count"`
	RegistryPath string `json:"registry_path"`
}

type JobDiagInfo struct {
	Note string `json:"note"`
}

func buildDiagnosticReport(cfg *config.Config, registryPath string) DiagnosticReport {
	report := DiagnosticReport{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Errors:      []string{},
	}
	report.System = SystemInfo{
		Hostname:      getHostname(),
		OS:            "windows",
		Architecture:  "amd64",
		DataDirectory: configPathDir(registryPath),
	}
	report.Spooler = SpoolerInfo{
		Note: "Per-queue evidence is attached to each queue entry (OpenPrinter/GetPrinter verdicts). No document is submitted by diagnose.",
	}
	report.Agent = AgentDiagInfo{
		AgentID:      cfg.Agent.ID,
		AgentName:    cfg.Agent.Name,
		Paired:       cfg.Agent.ID != "" && cfg.Agent.Secret != "",
		PrinterCount: len(cfg.Printers),
		RegistryPath: registryPath,
	}
	report.Transport = TransportInfo{
		GatewayURL:        cfg.Server.URL,
		HeartbeatInterval: "30s",
	}
	result := printer.Discover(cfg, registryPath)
	for _, e := range result.Errors {
		report.Errors = append(report.Errors, e)
	}
	for _, p := range result.Printers {
		q := QueueInfo{
			Name:           p.Name,
			ConnectionType: p.ConnectionType,
			Protocol:       p.Protocol,
			Status:         p.Status,
		}
		if p.Capabilities != nil {
			if v, ok := p.Capabilities["driver_name"]; ok {
				q.Driver = fmt.Sprint(v)
			}
			if v, ok := p.Capabilities["port_name"]; ok {
				q.Port = fmt.Sprint(v)
			}
		}
		cls := printer.ClassifyDeviceInfo(p)
		q.Classification = string(cls.Class)
		q.ClassificationReason = strings.Join(cls.Reasons, ";")
		if p.SpoolerName != "" {
			probe := printer.ProbeSpoolerQueue(p.SpoolerName)
			q.Driver = firstNonEmpty(q.Driver, probe.DriverName)
			q.Port = firstNonEmpty(q.Port, probe.PortName)
			q.SpoolerVerdict = probe.Verdict
			q.SpoolerVerdictReason = probe.VerdictReason
			q.SpoolerWorkOffline = probe.WorkOffline
			q.SpoolerStatusFlags = probe.StatusFlags
			q.SpoolerPendingJobs = probe.PendingJobs
			q.SpoolerOpenOK = probe.OpenPrinterOK
			q.SpoolerOpenError = probe.OpenPrinterError
			q.SpoolerGetOK = probe.GetPrinterOK
			q.SpoolerGetError = probe.GetPrinterError
		}
		report.Queues = append(report.Queues, q)
		d := DeviceInfo{
			Name:           p.Name,
			ConnectionType: p.ConnectionType,
			Status:         p.Status,
		}
		if p.USBVID != "" {
			d.VID = p.USBVID
		}
		if p.USBPID != "" {
			d.PID = p.USBPID
		}
		if p.USBSerial != "" {
			d.Serial = p.USBSerial
		}
		if p.Endpoint != "" {
			d.DevicePath = p.Endpoint
		}
		if p.Capabilities != nil {
			if v, ok := p.Capabilities["manufacturer"]; ok {
				d.Manufacturer = fmt.Sprint(v)
			}
		}
		report.Devices = append(report.Devices, d)
	}
	sort.Slice(report.Queues, func(i, j int) bool { return report.Queues[i].Name < report.Queues[j].Name })
	sort.Slice(report.Devices, func(i, j int) bool { return report.Devices[i].Name < report.Devices[j].Name })
	return report
}

func printDiagnosticReport(report DiagnosticReport) {
	fmt.Println("========================================")
	fmt.Println("Yasser Agent — Printer Diagnostic Report")
	fmt.Println("========================================")
	fmt.Printf("Generated: %s\n\n", report.GeneratedAt)
	fmt.Println("--- System ---")
	fmt.Printf("  Hostname: %s\n  OS: %s\n  Arch: %s\n\n", report.System.Hostname, report.System.OS, report.System.Architecture)
	fmt.Println("--- Agent ---")
	fmt.Printf("  ID: %s  Name: %s  Paired: %v  Printers: %d\n\n", report.Agent.AgentID, report.Agent.AgentName, report.Agent.Paired, report.Agent.PrinterCount)
	fmt.Println("--- Queues ---")
	if len(report.Queues) == 0 {
		fmt.Println("  No queues discovered")
	}
	for _, q := range report.Queues {
		fmt.Printf("  %s\n    Driver: %s\n    Port: %s\n    Status: %s\n    Type: %s / %s\n",
			q.Name, q.Driver, q.Port, q.Status, q.ConnectionType, q.Protocol)
		if q.Classification != "" {
			fmt.Printf("    Class: %s (%s)\n", q.Classification, q.ClassificationReason)
		}
		if q.SpoolerVerdict != "" {
			fmt.Printf("    Spooler: %s — %s\n", q.SpoolerVerdict, q.SpoolerVerdictReason)
			fmt.Printf("    WorkOffline: %v  Flags: 0x%08x  Pending: %d  OpenOK: %v  GetOK: %v\n",
				q.SpoolerWorkOffline, q.SpoolerStatusFlags, q.SpoolerPendingJobs, q.SpoolerOpenOK, q.SpoolerGetOK)
			if q.SpoolerOpenError != "" {
				fmt.Printf("    OpenPrinter: %s\n", q.SpoolerOpenError)
			}
			if q.SpoolerGetError != "" {
				fmt.Printf("    GetPrinter: %s\n", q.SpoolerGetError)
			}
		}
	}
	fmt.Println()
	if len(report.Errors) > 0 {
		fmt.Println("--- Errors ---")
		for _, e := range report.Errors {
			fmt.Printf("  ! %s\n", e)
		}
		fmt.Println()
	}
	fmt.Println("========================================")
}

func getHostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown"
	}
	return h
}

func configPathDir(path string) string {
	idx := strings.LastIndex(path, string(os.PathSeparator))
	if idx < 0 {
		return "."
	}
	return path[:idx]
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
