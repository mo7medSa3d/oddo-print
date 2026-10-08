package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// IPPPrinter implements IPP/IPPS printing via HTTP POST to the printer URI.
// Supports ipp://, ipps://, http://, https:// with path /ipp/print etc.
//
// IPP is a document transport, not a raw spooler. The Agent queries
// document-format-supported to select native PDF or a Windows one-page
// PDF -> JPEG fallback. Raw ESC/POS/ZPL data are never disguised as IPP
// documents. Raster-only printers require a Windows spooler driver.
type IPPPrinter struct {
	URL              string // normalized http(s) transport URL, always credential-free
	PrinterURI       string // credential-free URI carried in the IPP printer-uri attribute
	Name             string
	creds            *url.Userinfo // optional basic-auth from the configured URL
	statusMu         sync.RWMutex
	lastStatusDetail string
}

func (p *IPPPrinter) setStatusDetail(detail string) {
	p.statusMu.Lock()
	p.lastStatusDetail = detail
	p.statusMu.Unlock()
}

// StatusDetail exposes the most recent protocol-level reason without changing
// the canonical health enum. The Agent heartbeat carries it as diagnostic
// capability metadata so Gateway/UI can distinguish administrative stop/reject
// from physical offline while keeping routing based on the status enum.
func (p *IPPPrinter) StatusDetail() string {
	p.statusMu.RLock()
	defer p.statusMu.RUnlock()
	return p.lastStatusDetail
}

func NewIPPPrinter(rawURL, name string) (*IPPPrinter, error) {
	if rawURL == "" {
		return nil, fmt.Errorf("IPP printer URL required")
	}
	u, err := normalizeIPPURL(rawURL)
	if err != nil {
		return nil, err
	}

	creds := u.User
	transportURL := *u
	transportURL.User = nil

	printerURI := transportURL.String()
	lowerRaw := strings.ToLower(strings.TrimSpace(rawURL))
	if strings.HasPrefix(lowerRaw, "ipp://") {
		printerURIURL := transportURL
		printerURIURL.Scheme = "ipp"
		printerURI = printerURIURL.String()
	} else if strings.HasPrefix(lowerRaw, "ipps://") {
		printerURIURL := transportURL
		printerURIURL.Scheme = "ipps"
		printerURI = printerURIURL.String()
	}

	return &IPPPrinter{
		URL:        transportURL.String(),
		PrinterURI: printerURI,
		Name:       name,
		creds:      creds,
	}, nil
}

func normalizeIPPURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty IPP URL")
	}
	if !strings.Contains(raw, "://") {
		if _, _, err := net.SplitHostPort(raw); err == nil {
			raw = "http://" + raw + "/ipp/print"
		} else if net.ParseIP(strings.Trim(raw, "[]")) != nil {
			raw = "http://" + raw + ":631/ipp/print"
		} else if strings.Contains(raw, ".") && !strings.Contains(raw, "/") {
			raw = "http://" + raw + ":631/ipp/print"
		} else if !strings.HasPrefix(strings.ToLower(raw), "http") {
			raw = "http://" + raw
		}
	}
	lower := strings.ToLower(raw)
	wasIPP := strings.HasPrefix(lower, "ipp://")
	wasIPPS := strings.HasPrefix(lower, "ipps://")
	if wasIPP {
		raw = "http://" + raw[6:]
	} else if wasIPPS {
		raw = "https://" + raw[7:]
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid IPP URL %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("IPP URL scheme must be http/https/ipp/ipps, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("IPP URL host missing")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("IPP URL must not carry a query or fragment")
	}
	if (wasIPP || wasIPPS) && u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), "631")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/ipp/print"
	}
	return u, nil
}

func (p *IPPPrinter) requestURL() string {
	u, err := url.Parse(p.URL)
	if err != nil {
		return p.URL
	}
	u.User = nil
	return u.String()
}

func (p *IPPPrinter) Print(ctx context.Context, data []byte) error {
	// A bare Print with no document kind is treated as a PDF submission and
	// is validated as such — IPP never silently byte-spools unknown formats.
	if err := ValidatePDF(data); err != nil {
		return err
	}
	return p.printPDFWithFormatNegotiation(ctx, data)
}

func (p *IPPPrinter) PrintDocument(ctx context.Context, doc Document) error {
	kind := NormalizeKind(doc.Kind)
	format, ok := ippDocumentFormatFor(kind)
	if !ok {
		return CapabilityMismatchf("IPP printer %s cannot render %s payloads", p.URL, kind)
	}
	if kind == KindPDF {
		if err := ValidatePDF(doc.Data); err != nil {
			return err
		}
	}
	if len(doc.Data) == 0 {
		return fmt.Errorf("refusing to print empty payload")
	}
	if len(doc.Data) > maxPrintBytes {
		return fmt.Errorf("payload %d exceeds %d limit", len(doc.Data), maxPrintBytes)
	}
	if format == ippFormatPDF {
		return p.printPDFWithFormatNegotiation(ctx, doc.Data)
	}
	return p.printDocument(ctx, doc.Data, format)
}

func (p *IPPPrinter) SupportsKind(kind string) bool {
	_, ok := ippDocumentFormatFor(NormalizeKind(kind))
	return ok
}

func ippDocumentFormatFor(kind string) (string, bool) {
	switch kind {
	case KindPDF:
		return ippFormatPDF, true
	default:
		return "", false
	}
}

// preDispatchIRErr reports whether a transport error proves the IPP request
// never left the machine (safe retry classification).
func preDispatchIRErr(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

func (p *IPPPrinter) printDocument(ctx context.Context, data []byte, documentFormat string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	ippReq := buildIPPPrintJobWithFormat(p.PrinterURI, data, documentFormat)
	req, err := http.NewRequestWithContext(ctx, "POST", p.requestURL(), bytes.NewReader(ippReq))
	if err != nil {
		return fmt.Errorf("IPP create request for %s: %w", p.URL, err)
	}
	req.Header.Set("Content-Type", "application/ipp")
	req.Header.Set("Accept", "application/ipp")
	req.Header.Set("Expect", "")
	if p.creds != nil {
		if pass, ok := p.creds.Password(); ok {
			req.SetBasicAuth(p.creds.Username(), pass)
		}
	}
	client := &http.Client{
		Timeout: 15 * time.Second,
		// IPP print submissions contain the complete document. Never follow a
		// redirect because it could resend the payload to an unintended host.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if deadline, ok := ctx.Deadline(); ok {
		// Honor the print budget: a large/slow IPP transfer legitimately
		// outlives the 15s stall floor, and the budget context already
		// bounds the whole job. Without this, slow-but-progressing jobs
		// are killed at 15s despite a multi-minute budget.
		if timeout := time.Until(deadline); timeout > 0 {
			client.Timeout = timeout
		}
	}
	if err := runDispatchAdmission(ctx); err != nil {
		return fmt.Errorf("IPP print admission refused: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		if preDispatchIRErr(err) {
			// Never transmitted: a clean, safely retryable failure.
			return fmt.Errorf("IPP printer %s unreachable (request not sent): %w", p.URL, err)
		}
		// The request may already have reached the device and created a
		// spooled job; the physical outcome is genuinely unknown.
		return fmt.Errorf("%s: IPP submission to %s failed after transmission may have occurred: %w", ErrOutcomeUnknown, p.URL, err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 500 {
			return fmt.Errorf("%s: IPP printer %s returned HTTP %d (submission may have been accepted)", ErrOutcomeUnknown, p.URL, resp.StatusCode)
		}
		return fmt.Errorf("IPP printer %s rejected the request with HTTP %d", p.URL, resp.StatusCode)
	}
	if readErr != nil {
		return fmt.Errorf("%s: IPP response from %s was truncated (job state unknown): %w", ErrOutcomeUnknown, p.URL, readErr)
	}
	status, msg := parseIPPStatus(body)
	if status == 0xFFFF {
		return fmt.Errorf("%s: IPP response from %s was truncated (job state unknown): %s", ErrOutcomeUnknown, p.URL, msg)
	}
	if status >= 0x0500 && status <= 0x05ff {
		return fmt.Errorf("%s: IPP printer %s returned server error 0x%04x (%s); the job may be queued (physical outcome unknown)", ErrOutcomeUnknown, p.URL, status, ippStatusText(status))
	}
	if status >= 0x0400 && status <= 0x04ff {
		if status == 0x040A {
			return fmt.Errorf("IPP printer %s rejected document-format %s (0x040A: %s): %s. Verify document-format-supported and use the Windows spooler driver if necessary", p.URL, documentFormat, ippStatusText(status), msg)
		}
		return fmt.Errorf("IPP printer %s returned client error 0x%04x (%s): %s", p.URL, status, ippStatusText(status), msg)
	}
	if status > 0x00ff {
		return fmt.Errorf("%s: IPP printer %s returned unknown status 0x%04x (%s)", ErrOutcomeUnknown, p.URL, status, ippStatusText(status))
	}
	log.Printf("IPP accepted %d bytes (%s) at %s (IPP 0x%04x; physical output not confirmed)", len(data), documentFormat, p.URL, status)
	return nil
}

func (p *IPPPrinter) Test(ctx context.Context) error {
	// A local diagnostic test page would need a real PDF document; the agent
	// does not fabricate one. Use the operator-console "send test page"
	// action, which routes a genuine ticket through the gateway.
	return fmt.Errorf("IPP local test page is not supported; send a test print from the Gateway console instead")
}

// Status differentiates transport failure from unsupported status and from
// a genuinely responsive device. A timeout/unreachable maps to "offline"
// (never "online"); an answered query without a usable printer-state maps
// to "unknown" (never "online").
func (p *IPPPrinter) Status() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	attrs, err := p.getPrinterAttributes(ctx)
	if err != nil {
		// Probe/auth/protocol/transport failures are control-plane evidence only.
		// They do not prove the physical device is offline.
		p.setStatusDetail("probe_failed")
		return "unknown"
	}
	if attrs == nil {
		p.setStatusDetail("attributes_missing")
		return "unknown"
	}

	status, detail := interpretIPPPrinterStatus(attrs)
	p.setStatusDetail(detail)
	return status
}

// interpretIPPPrinterStatus maps one Get-Printer-Attributes response to the
// shared Gateway status vocabulary. It is a pure function of the attributes
// so discovery-time classification and runtime Status() cannot diverge, and
// discovery reuses its own probe response instead of issuing a second probe.
func interpretIPPPrinterStatus(attrs map[string]string) (status, detail string) {
	if attrs == nil {
		return "unknown", "attributes_missing"
	}
	reasons := strings.ToLower(attrs["printer-state-reasons"])
	if reasons != "" {
		detail = reasons
	} else {
		detail = "none"
	}
	if reasons != "" && reasons != "none" {
		for _, marker := range []string{"media-empty", "media-needed", "cover-open", "door-open", "toner-empty", "developer-empty", "marker-supply-empty", "jam", "interlock-open"} {
			if strings.Contains(reasons, marker) {
				return "error", detail
			}
		}
		if strings.Contains(reasons, "offline") || strings.Contains(reasons, "shutdown") {
			return "offline", detail
		}
		for _, marker := range []string{"paused", "moving-to-paused", "hold-new-jobs", "spool-area-full"} {
			if strings.Contains(reasons, marker) {
				return "error", detail
			}
		}
	}

	if state, ok := attrs["printer-state"]; ok {
		switch state {
		case "3":
			if accepting, ok := attrs["printer-is-accepting-jobs"]; ok && strings.EqualFold(accepting, "false") {
				return "error", detail
			}
			return "online", detail
		case "4":
			if accepting, ok := attrs["printer-is-accepting-jobs"]; ok && strings.EqualFold(accepting, "false") {
				return "error", detail
			}
			return "busy", detail
		case "5":
			// STOPPED is not synonymous with physical offline. Reasons above
			// decide offline vs device/admin error when available.
			return "error", detail
		default:
			return "unknown", detail
		}
	}
	if accepting, ok := attrs["printer-is-accepting-jobs"]; ok && strings.EqualFold(accepting, "false") {
		return "error", detail
	}
	return "unknown", detail
}

var errIPPStatusUnsupported = errors.New("get-printer-attributes unsupported")

func (p *IPPPrinter) getPrinterAttributes(ctx context.Context) (map[string]string, error) {
	ippReq := buildIPPGetPrinterAttributes(p.PrinterURI)
	req, err := http.NewRequestWithContext(ctx, "POST", p.requestURL(), bytes.NewReader(ippReq))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/ipp")
	if p.creds != nil {
		if pass, ok := p.creds.Password(); ok {
			req.SetBasicAuth(p.creds.Username(), pass)
		}
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		// Status probes must stay bound to the configured printer endpoint.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return nil, fmt.Errorf("HTTP %d: %w", resp.StatusCode, errIPPStatusUnsupported)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if readErr != nil {
		return nil, readErr
	}
	status, msg := parseIPPStatus(body)
	if status == 0xFFFF {
		return nil, fmt.Errorf("truncated IPP response: %s", msg)
	}
	if status > 0x00ff {
		return nil, fmt.Errorf("IPP status 0x%04x: %w", status, errIPPStatusUnsupported)
	}
	return parseIPPAttributes(body), nil
}

const (
	ippFormatPDF = "application/pdf"
)

func buildIPPPrintJobWithFormat(printerURI string, document []byte, documentFormat string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x0002))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttribute(&buf, 0x49, "document-format", documentFormat)
	writeIPPAttribute(&buf, 0x42, "job-name", "Yaseir Print Job")
	buf.WriteByte(0x03)
	buf.Write(document)
	return buf.Bytes()
}

func buildIPPGetPrinterAttributes(printerURI string) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x02, 0x00})
	binary.Write(&buf, binary.BigEndian, uint16(0x000B))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	buf.WriteByte(0x01)
	writeIPPAttribute(&buf, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&buf, 0x48, "attributes-natural-language", "en")
	writeIPPAttribute(&buf, 0x45, "printer-uri", printerURI)
	writeIPPAttribute(&buf, 0x42, "requesting-user-name", "odoo-agent")
	writeIPPAttribute(&buf, 0x44, "requested-attributes", "printer-state")
	writeIPPAttribute(&buf, 0x44, "", "printer-state-reasons")
	writeIPPAttribute(&buf, 0x44, "", "printer-is-accepting-jobs")
	writeIPPAttribute(&buf, 0x44, "", "document-format-supported")
	writeIPPAttribute(&buf, 0x44, "", "document-format-default")
	writeIPPAttribute(&buf, 0x44, "", "pwg-raster-document-type-supported")
	writeIPPAttribute(&buf, 0x44, "", "pwg-raster-document-resolution-supported")
	buf.WriteByte(0x03)
	return buf.Bytes()
}

func writeIPPAttribute(buf *bytes.Buffer, tag byte, name, value string) {
	buf.WriteByte(tag)
	binary.Write(buf, binary.BigEndian, uint16(len(name)))
	buf.WriteString(name)
	binary.Write(buf, binary.BigEndian, uint16(len(value)))
	buf.WriteString(value)
}

// completeIPPResponse validates framing before a success status can be used
// as submission evidence. A status header alone is not a complete response.
func completeIPPResponse(data []byte) bool {
	if len(data) < 9 || (data[0] != 1 && data[0] != 2) || binary.BigEndian.Uint32(data[4:8]) != 1 {
		return false
	}
	inGroup := false
	hasName := false
	for i := 8; i < len(data); {
		tag := data[i]
		i++
		if tag == 0x03 {
			return i == len(data)
		}
		if tag <= 0x0f {
			if tag == 0 {
				return false
			}
			inGroup = true
			hasName = false
			continue
		}
		if !inGroup || i+2 > len(data) {
			return false
		}
		nameLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if i+nameLen+2 > len(data) || (nameLen == 0 && !hasName) {
			return false
		}
		hasName = true
		i += nameLen
		valueLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if i+valueLen > len(data) {
			return false
		}
		i += valueLen
	}
	return false
}

func parseIPPStatus(data []byte) (uint16, string) {
	if !completeIPPResponse(data) {
		return 0xFFFF, "invalid or truncated IPP response"
	}
	status := binary.BigEndian.Uint16(data[2:4])
	attrs := parseIPPAttributes(data)
	if msg := attrs["status-message"]; msg != "" {
		return status, msg
	}
	return status, ""
}

// logRecoveredIPPParse reports a panic recovered while parsing IPP attribute
// bytes taken straight off the network. The recovery itself is deliberate
// hardening — a malformed packet must not take down discovery — but it used to
// be a bare `_ = recover()`, so a parser panic left no trace at all. Extracted
// from the deferred closure so the reporting behaviour is directly testable.
func logRecoveredIPPParse(dataLen int, recovered interface{}) {
	log.Printf("WARNING: recovered from malformed IPP attributes (len=%d): %v", dataLen, recovered)
}

func parseIPPAttributes(data []byte) map[string]string {
	out := make(map[string]string)
	defer func() {
		if r := recover(); r != nil {
			logRecoveredIPPParse(len(data), r)
		}
	}()
	if len(data) < 8 {
		return out
	}
	i := 8
	currentName := ""
	for i < len(data) {
		tag := data[i]
		i++
		if tag == 0x03 {
			break
		}
		if tag <= 0x0F {
			currentName = ""
			continue
		}
		if i+2 > len(data) {
			break
		}
		nameLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if nameLen < 0 || i+nameLen > len(data) {
			break
		}
		if nameLen > 0 {
			currentName = string(data[i : i+nameLen])
		}
		i += nameLen
		if i+2 > len(data) {
			break
		}
		valueLen := int(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
		if valueLen < 0 || i+valueLen > len(data) {
			break
		}
		raw := data[i : i+valueLen]
		i += valueLen
		if currentName == "" {
			continue
		}
		val := decodeIPPValue(tag, raw)
		if val == "" {
			continue
		}
		if existing, ok := out[currentName]; ok && existing != "" {
			out[currentName] = existing + "," + val
		} else {
			out[currentName] = val
		}
	}
	return out
}

func decodeIPPValue(tag byte, raw []byte) string {
	switch tag {
	case 0x10, 0x12, 0x13:
		return ""
	case 0x21, 0x23:
		if len(raw) != 4 {
			return ""
		}
		return fmt.Sprintf("%d", int32(binary.BigEndian.Uint32(raw)))
	case 0x22:
		if len(raw) != 1 {
			return ""
		}
		if raw[0] != 0 {
			return "true"
		}
		return "false"
	case 0x32: // resolution: 4-byte X, 4-byte Y, 1-byte units
		if len(raw) != 9 {
			return ""
		}
		x := binary.BigEndian.Uint32(raw[:4])
		y := binary.BigEndian.Uint32(raw[4:8])
		if x == 0 || y == 0 || x > 1200 || y > 1200 {
			return ""
		}
		if raw[8] == 3 { // dots per inch
			return fmt.Sprintf("%dx%ddpi", x, y)
		}
		if raw[8] == 4 { // dots per centimetre
			return fmt.Sprintf("%dx%ddpcm", x, y)
		}
		return ""
	case 0x30, 0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49:
		return string(raw)
	default:
		for _, b := range raw {
			if b < 0x20 || b > 0x7e {
				return ""
			}
		}
		return string(raw)
	}
}

func ippStatusText(status uint16) string {
	switch status {
	case 0x0000:
		return "successful-ok"
	case 0x0001:
		return "successful-ok-ignored-or-substituted-attributes"
	case 0x0400:
		return "client-error-bad-request"
	case 0x0401:
		return "client-error-forbidden"
	case 0x0402:
		return "client-error-not-authenticated"
	case 0x0403:
		return "client-error-not-authorized"
	case 0x0404:
		return "client-error-not-possible"
	case 0x040A:
		return "client-error-document-format-not-supported"
	case 0x0500:
		return "server-error-internal-error"
	case 0x0501:
		return "server-error-operation-not-supported"
	case 0x0503:
		return "server-error-version-not-supported"
	default:
		return fmt.Sprintf("unknown-0x%04x", status)
	}
}
