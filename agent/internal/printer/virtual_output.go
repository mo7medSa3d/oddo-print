package printer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// isPromptingVirtualPort reports whether a Windows spooler port monitor opens
// an interactive "Save Print Output As..." dialog when pOutputFile is nil.
// Inside a Windows Service (Session 0), interactive dialogs cannot be shown,
// so jobs targeting these ports must supply an explicit output file path.
func isPromptingVirtualPort(portName string) bool {
	p := strings.ToUpper(strings.TrimSpace(portName))
	if p == "" {
		return false
	}
	return strings.HasPrefix(p, "PORTPROMPT:") ||
		strings.HasPrefix(p, "FILE:") ||
		strings.HasPrefix(p, "XPSPORT:")
}

func virtualOutputExtension(portName, driverName, printerName string) string {
	p := strings.ToLower(strings.TrimSpace(portName))
	combined := strings.ToLower(strings.TrimSpace(driverName) + " " + strings.TrimSpace(printerName))
	if strings.HasPrefix(p, "xpsport:") || strings.Contains(combined, "xps") {
		return ".xps"
	}
	if strings.Contains(combined, "pdf") {
		return ".pdf"
	}
	return ".prn"
}

func defaultVirtualOutputDir() string {
	if custom := strings.TrimSpace(os.Getenv("YASEIR_VIRTUAL_OUTPUT_DIR")); custom != "" {
		return custom
	}
	if programData := strings.TrimSpace(os.Getenv("PROGRAMDATA")); programData != "" {
		return filepath.Join(programData, "YaseirAgent", "virtual-output")
	}
	return filepath.Join(os.TempDir(), "yaseir-virtual-output")
}

func sanitizeOutputToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(raw))
	lastDash := false
	for _, r := range raw {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if isAlphaNum || r == '_' {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= 48 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

// buildVirtualOutputPath constructs a deterministic, collision-safe output file
// path for prompting virtual ports (PORTPROMPT:, FILE:, XPSPORT:). Returns ""
// when portName is not a prompting virtual port.
func buildVirtualOutputPath(baseDir, portName, driverName, printerName, jobID string, now time.Time) string {
	if !isPromptingVirtualPort(portName) {
		return ""
	}
	if strings.TrimSpace(baseDir) == "" {
		baseDir = defaultVirtualOutputDir()
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	printerTok := sanitizeOutputToken(printerName)
	if printerTok == "" {
		printerTok = "virtual-printer"
	}
	jobTok := sanitizeOutputToken(jobID)
	stamp := now.UTC().Format("20060102-150405.000000000")
	name := fmt.Sprintf("%s-%s", printerTok, stamp)
	if jobTok != "" {
		name = fmt.Sprintf("%s-%s-%s", printerTok, jobTok, stamp)
	}
	return filepath.Join(baseDir, name+virtualOutputExtension(portName, driverName, printerName))
}
