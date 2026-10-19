package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
	"github.com/yaseir-agent/agent/internal/printer"
)

// Test capture is an isolated LOCAL diagnostic: no printer record, no network,
// no Gateway job, no Windows spooler and no "printed" acknowledgement.
type captureTestResponse struct {
	Outcome        string `json:"outcome"`
	Renderer       string `json:"renderer"`
	Pages          int    `json:"pages"`
	PaperMM        int    `json:"paperMm"`
	InputFormat    string `json:"inputFormat"`
	PDFPath        string `json:"pdfPath"`
	PreviewPath    string `json:"previewPath"`
	PreviewDataURI string `json:"previewDataUri"`
	SHA256         string `json:"sha256"`
	PDFBytes       int    `json:"pdfBytes"`
}

func readBoundedCapture(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() < 1 || stat.Size() > printer.MaxLocalCaptureInput {
		return nil, fmt.Errorf("test document must be a regular file of at most 4 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, printer.MaxLocalCaptureInput+1))
	if err != nil {
		return nil, err
	}
	if len(data) < 1 || len(data) > printer.MaxLocalCaptureInput {
		return nil, fmt.Errorf("test document changed size during read")
	}
	return data, nil
}

func writePrivateCapture(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	// Go file modes on Windows do not harden DACLs. All artifacts live inside
	// an explicitly protected directory and get a protected file ACL too.
	if err = config.EnsureSecureFileACL(path); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}

func pruneLocalCaptures(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		name string
		when time.Time
	}
	files := make([]item, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !isCaptureOutputName(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if time.Since(info.ModTime()) > 48*time.Hour {
			_ = os.Remove(filepath.Join(dir, name))
		} else {
			files = append(files, item{name, info.ModTime()})
		}
	}
	// At most 20 result pairs (40 files); no unbounded private-document cache.
	sort.Slice(files, func(i, j int) bool { return files[i].when.Before(files[j].when) })
	for i := 0; i < len(files)-40; i++ {
		_ = os.Remove(filepath.Join(dir, files[i].name))
	}
}

func makeLocalCapture(ctx context.Context, inputPath, outputDir, format string, paperMM int) (captureTestResponse, error) {
	data, err := readBoundedCapture(inputPath)
	if err != nil {
		return captureTestResponse{}, err
	}
	if err := os.MkdirAll(outputDir, 0700); err != nil {
		return captureTestResponse{}, err
	}
	if err := config.EnsureSecureDirectoryACL(outputDir); err != nil {
		return captureTestResponse{}, err
	}
	result, err := printer.CaptureTestDocument(ctx, data, format, paperMM)
	if err != nil {
		return captureTestResponse{}, err
	}

	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		return captureTestResponse{}, err
	}
	stem := "capture-" + hex.EncodeToString(id)
	pdfPath := filepath.Join(outputDir, stem+".pdf")
	pngPath := filepath.Join(outputDir, stem+".png")
	if err := writePrivateCapture(pdfPath, result.PDF); err != nil {
		return captureTestResponse{}, err
	}
	if err := writePrivateCapture(pngPath, result.PreviewPNG); err != nil {
		_ = os.Remove(pdfPath)
		return captureTestResponse{}, err
	}
	pruneLocalCaptures(outputDir)
	digest := sha256.Sum256(result.PDF)
	return captureTestResponse{
		Outcome:        "rendered_locally",
		Renderer:       "embedded_pdfium",
		Pages:          result.Pages,
		PaperMM:        paperMM,
		InputFormat:    format,
		PDFPath:        pdfPath,
		PreviewPath:    pngPath,
		PreviewDataURI: "data:image/png;base64," + base64.StdEncoding.EncodeToString(result.PreviewPNG),
		SHA256:         hex.EncodeToString(digest[:]),
		PDFBytes:       len(result.PDF),
	}, nil
}

func handleCaptureTest(args []string) error {
	opts := flag.NewFlagSet("capture-test", flag.ContinueOnError)
	opts.SetOutput(io.Discard)
	input := opts.String("input", "", "local input file")
	dest := opts.String("output-dir", "", "private capture folder")
	format := opts.String("format", "", "jpeg or pdf")
	paper := opts.Int("paper-mm", 0, "0 / 58 / 80")
	if err := opts.Parse(args); err != nil {
		return fmt.Errorf("invalid test-capture arguments: %w", err)
	}
	if opts.NArg() != 0 || *input == "" || *dest == "" {
		return fmt.Errorf("capture-test requires input, output-dir, format and paper-mm")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	result, err := makeLocalCapture(ctx, *input, *dest, *format, *paper)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
