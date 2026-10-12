package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

const maxCaptureResponseBytes = 6 * 1024 * 1024
const maxCapturePreviewBytes = 256 * 1024

// E2E capture messages are not print jobs and never pass through dispatchJob,
// printer.New, the physical queue, Windows spooler, or status "success".
type e2eCaptureEnvelope struct {
	RunID      string  `json:"runId"`
	ClaimToken string  `json:"claimToken"`
	PaperMM    int     `json:"paperMm"`
	Simulation bool    `json:"simulationOnly"`
	PrinterID  *string `json:"physicalPrinterId"`
	Payload    struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	} `json:"payload"`
}

func (e e2eCaptureEnvelope) decode() ([]byte, string, error) {
	if e.PrinterID != nil || !e.Simulation ||
		len(e.RunID) != 36 || !strings.HasPrefix(e.RunID, "cap_") ||
		len(e.ClaimToken) != 64 {
		return nil, "", fmt.Errorf("invalid simulation envelope")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(e.RunID, "cap_")); err != nil {
		return nil, "", fmt.Errorf("invalid capture id")
	}
	if _, err := hex.DecodeString(e.ClaimToken); err != nil {
		return nil, "", fmt.Errorf("invalid capture claim")
	}
	if (e.Payload.Type != "pdf" && e.Payload.Type != "image") ||
		e.Payload.Encoding != "base64" ||
		(e.PaperMM != 0 && e.PaperMM != 58 && e.PaperMM != 80) ||
		(e.Payload.Type == "pdf" && e.PaperMM != 0) ||
		len(e.Payload.Data) > (printer.MaxLocalCaptureInput/3)*4+8 {
		return nil, "", fmt.Errorf("unsupported capture document")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(e.Payload.Data)
	if err != nil || len(data) == 0 || len(data) > printer.MaxLocalCaptureInput ||
		base64.StdEncoding.EncodeToString(data) != e.Payload.Data {
		return nil, "", fmt.Errorf("invalid or oversized capture payload")
	}
	format := "jpeg"
	if e.Payload.Type == "pdf" {
		format = "pdf"
	}
	return data, format, nil
}

type captureTerminal struct {
	RunID       string `json:"runId"`
	ClaimToken  string `json:"claimToken"`
	Status      string `json:"status"`
	Pages       int    `json:"pages,omitempty"`
	PDFSHA256   string `json:"pdfSha256,omitempty"`
	PDFBytes    int    `json:"pdfBytes,omitempty"`
	PreviewJPEG string `json:"previewJpeg,omitempty"`
	ErrorCode   string `json:"errorCode,omitempty"`
}

func captureThumbnail(pngData []byte) string {
	source, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		return ""
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, source, &jpeg.Options{Quality: 68}); err != nil ||
		output.Len() > maxCapturePreviewBytes {
		return ""
	}
	return base64.StdEncoding.EncodeToString(output.Bytes())
}

// Save private evidence only on the Agent host. Keep bytes and private paths
// off the public Gateway: the Gateway stores a digest and a bounded preview.
func (a *Agent) writeRemoteCaptureArtifacts(pdf, preview []byte) error {
	if a.configPath == "" {
		return fmt.Errorf("Agent configuration location unavailable")
	}
	dir := filepath.Join(filepath.Dir(a.configPath), "e2e-captures")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := config.EnsureSecureDirectoryACL(dir); err != nil {
		return err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	baseName := "capture-" + hex.EncodeToString(nonce)
	pdfPath := filepath.Join(dir, baseName+".pdf")
	pngPath := filepath.Join(dir, baseName+".png")
	write := func(path string, data []byte) (retErr error) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer func() {
			retErr = errors.Join(retErr, f.Close())
			if retErr != nil {
				_ = os.Remove(path)
			}
		}()
		if err := config.EnsureSecureFileACL(path); err != nil {
			return err
		}
		if _, err := f.Write(data); err != nil {
			return err
		}
		return f.Sync()
	}
	if err := write(pdfPath, pdf); err != nil {
		return err
	}
	if err := write(pngPath, preview); err != nil {
		_ = os.Remove(pdfPath)
		return err
	}
	pruneRemoteCaptures(dir)
	return nil
}

func pruneRemoteCaptures(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type artifact struct {
		name string
		date time.Time
	}
	found := make([]artifact, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "capture-") ||
			(!strings.HasSuffix(e.Name(), ".pdf") && !strings.HasSuffix(e.Name(), ".png")) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if time.Since(info.ModTime()) >= 48*time.Hour {
			_ = os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		found = append(found, artifact{e.Name(), info.ModTime()})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].date.Before(found[j].date) })
	for i := 0; i < len(found)-40; i++ {
		_ = os.Remove(filepath.Join(dir, found[i].name))
	}
}

func (a *Agent) pollE2ECaptures(parent context.Context) {
	if !a.cfg.Server.E2ECaptureTests || runtime.GOOS != "windows" ||
		a.fencedForDispatch() || a.lifecycleBackoffActive() ||
		!a.captureMu.TryLock() {
		return
	}
	defer a.captureMu.Unlock()
	// Never let simulated PDFium work compete with an accepted physical job.
	if a.inFlightCount() > 0 || parent.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 65*time.Second)
	defer cancel()
	resp, err := a.doAuthorizedRequest(ctx, "GET", "/api/agent/test-captures", nil)
	if err != nil {
		log.Printf("E2E capture poll unavailable: %v", err)
		return
	}
	limited, err := io.ReadAll(io.LimitReader(resp.Body, maxCaptureResponseBytes+1))
	resp.Body.Close()
	if err != nil || len(limited) > maxCaptureResponseBytes {
		log.Println("E2E capture: rejected oversized/unreadable response")
		return
	}
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return
	}
	if resp.StatusCode != http.StatusOK {
		log.Printf("E2E capture poll returned HTTP %d", resp.StatusCode)
		return
	}
	var msg e2eCaptureEnvelope
	if err := json.Unmarshal(limited, &msg); err != nil {
		log.Println("E2E capture: invalid JSON envelope")
		return
	}
	data, format, err := msg.decode()
	if err != nil {
		log.Printf("E2E capture: rejected invalid envelope: %v", err)
		return
	}
	result := captureTerminal{RunID: msg.RunID, ClaimToken: msg.ClaimToken,
		Status: "failed", ErrorCode: "PDFIUM_FAILED"}
	renderCtx, stop := context.WithTimeout(ctx, 35*time.Second)
	captured, captureErr := printer.CaptureTestDocument(renderCtx, data, format, msg.PaperMM)
	stop()
	// Never log document bytes or return native renderer diagnostics to Odoo.
	if captureErr == nil {
		if len(captured.PDF) == 0 || len(captured.PDF) > 8*1024*1024 ||
			captured.Pages < 1 || captured.Pages > 10 {
			captureErr = fmt.Errorf("PDFium returned invalid bounded evidence")
		} else if err := a.writeRemoteCaptureArtifacts(captured.PDF, captured.PreviewPNG); err != nil {
			captureErr = err
			result.ErrorCode = "STORAGE_FAILED"
		} else {
			digest := sha256.Sum256(captured.PDF)
			result.Status = "rendered_locally"
			result.ErrorCode = ""
			result.Pages = captured.Pages
			result.PDFSHA256 = hex.EncodeToString(digest[:])
			result.PDFBytes = len(captured.PDF)
			result.PreviewJPEG = captureThumbnail(captured.PreviewPNG)
		}
	}
	if captureErr != nil {
		if errors.Is(captureErr, context.DeadlineExceeded) {
			result.ErrorCode = "TIMED_OUT"
		}
		log.Printf("E2E capture %s did not complete locally: %v", msg.RunID, captureErr)
	}
	ack, err := a.doAuthorizedRequest(ctx, "PATCH", "/api/agent/test-captures", result)
	if err != nil {
		log.Printf("E2E capture %s could not report result: %v", msg.RunID, err)
		return
	}
	defer ack.Body.Close()
	if ack.StatusCode != http.StatusOK {
		log.Printf("E2E capture %s result was not accepted (HTTP %d)", msg.RunID, ack.StatusCode)
	}
}
