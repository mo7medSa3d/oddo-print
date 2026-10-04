package printer

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Common discovery interfaces and extended discoverers for production-grade coverage.
// Each discoverer is safe, bounded, and never prints or modifies printer state.

// DiscoverySource constants — discovery origin, NOT printer protocol.
// Canonical scan values are emitted via these constants so the vocabulary
// stays in one place; transport-specific probe labels ("tcp_port_scan",
// "ipp_tcp_scan") remain free-form forensic detail inside capabilities.
const (
	SourceMDNS     = "mdns"
	SourceIPP      = "ipp"
	SourceIPPS     = "ipps"
	SourceRAW      = "raw"
	SourceLPR      = "lpr"
	SourceSNMP     = "snmp"
	SourceWSD      = "wsd"
	SourceSpooler  = "windows_spooler"
	SourceUSB      = "usb"
	SourceSubnet   = "subnet"
	SourceConfig   = "config"
	SourceRegistry = "registry"
)

// confidence helpers

// Deduplication: stable identity priority as per spec:
// 1. UUID, 2. serial+manufacturer/model, 3. MAC, 4. IP+URI, 5. hostname+port

func dedupeKey(di DeviceInfo) string {
	if key, ok := physicalIdentityKey(di); ok {
		return key
	}
	if di.NetworkAddress != "" && di.Port != 0 {
		return fmt.Sprintf("ip:%s:%d", strings.ToLower(di.NetworkAddress), di.Port)
	}
	if di.SpoolerName != "" {
		return "spooler:" + strings.ToLower(di.SpoolerName)
	}
	if di.NetworkAddress != "" {
		return "ip:" + strings.ToLower(di.NetworkAddress)
	}
	return "id:" + di.ID
}

// SNMP discovery: safe read-only query for printer MIB.
// Uses UDP 161 with community "public" (never hardcodes private credentials).
// Queries: sysDescr (1.3.6.1.2.1.1.1.0), sysName (1.3.6.1.2.1.1.5.0), hrDeviceDescr (1.3.6.1.2.1.25.3.2.1.3), printer MIB 1.3.6.1.2.1.43.5.1.1.17 (prtGeneralSerialNumber)

func discoverSNMPPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets) == 0 {
		return nil
	}
	const workers = 16
	const perHostTimeout = 1500 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for host := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				di := probeSNMPHost(ctx, host, perHostTimeout)
				if di != nil {
					select {
					case results <- *di:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	// Ownership law (mirrors network_discovery.go): results is closed ONLY
	// after every worker has finished sending. Abandoning the wait on
	// ctx.Done() and closing early made a straggling worker's
	// `select { case results <- di: case <-ctx.Done(): }` see a
	// send-on-closed channel that is simultaneously "ready" with the ctx
	// arm — Go picks uniformly and panics ~50% per late result. The wait is
	// bounded: workers finish within one perHostTimeout after ctx expires
	// (probe deadlines start at call time) and sends never block (buffer is
	// len(targets)), so the discovery budget is exceeded by at most ~1.5s.
	wg.Wait()
	close(results)
	var out []DeviceInfo
	seen := make(map[string]bool)
	for di := range results {
		k := dedupeKey(di)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, di)
	}
	return out
}

func probeSNMPHost(ctx context.Context, host string, timeout time.Duration) *DeviceInfo {
	// Build SNMPv1 GET for sysDescr
	pkt := buildSNMPGet([]string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"})
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, "161"))
	if err != nil {
		return nil
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return nil
	}
	defer conn.Close()
	stopCancellation := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancellation()
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return nil
	}
	if _, err := conn.Write(pkt); err != nil {
		return nil
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return nil
	}
	resp := buf[:n]
	// Very minimal validation: response should contain "1.3.6.1.2.1.1.1.0" and be printable
	sysDescr := extractSNMPString(resp)
	if sysDescr == "" {
		return nil
	}
	lower := strings.ToLower(sysDescr)
	// Heuristic: printer if sysDescr mentions printer, jetdirect, laser, etc.
	isPrinter := strings.Contains(lower, "printer") || strings.Contains(lower, "jetdirect") || strings.Contains(lower, "laser") || strings.Contains(lower, "zebra") || strings.Contains(lower, "epson") || strings.Contains(lower, "brother") || strings.Contains(lower, "hp") && strings.Contains(lower, "print")
	if !isPrinter {
		// Could still be printer, but need stronger signal: check if hrDeviceDescr contains printer
		if !strings.Contains(lower, "print") {
			return nil
		}
	}
	id := StableIDFromNetwork(host, 161)
	di := DeviceInfo{
		ID:             id,
		Name:           fmt.Sprintf("SNMP Printer %s", host),
		DisplayName:    sysDescr,
		PrinterType:    "unknown",
		ConnectionType: "network",
		// An SNMP sysDescr proves there is a print-capable HOST, not that a
		// raw 9100 byte sink exists on it. Protocol stays undeclared ("") so
		// the gateway treats this as a candidate, never as a routable raw
		// printer.
		Protocol:       "",
		Endpoint:       host,
		NetworkAddress: host,
		Status:         "unknown",
		Enabled:        true,
		Capabilities:   map[string]interface{}{"discovered_via": SourceSNMP, "sysDescr": sysDescr, "snmp_detected": true, "verification": "device_detected_only"},
	}
	// Try to parse manufacturer/model from sysDescr
	if parts := strings.Fields(sysDescr); len(parts) >= 2 {
		di.Capabilities["manufacturer"] = parts[0]
	}
	return &di
}

func buildSNMPGet(oids []string) []byte {
	// Minimal SNMPv1 GET construction (BER). Keep simple, not fully compliant but works for many agents.
	// Structure: SEQUENCE { version, community, PDU }
	var pdu bytes.Buffer
	// PDU type GET 0xA0
	pdu.WriteByte(0xA0)
	pduLenPos := pdu.Len()
	pdu.WriteByte(0) // placeholder
	// request-id
	pdu.Write([]byte{0x02, 0x04, 0x00, 0x00, 0x00, 0x01})
	// error-status, error-index
	pdu.Write([]byte{0x02, 0x01, 0x00, 0x02, 0x01, 0x00})
	// varbind list
	pdu.WriteByte(0x30) // SEQUENCE
	vbLenPos := pdu.Len()
	pdu.WriteByte(0)
	for _, oid := range oids {
		pdu.WriteByte(0x30) // varbind
		// VarBind length is the complete encoded OID TLV plus the NULL TLV.
		// The old fixed 0x0b length was incorrect for the 9-byte OIDs used
		// here: it declared 11 bytes while writing 13 bytes, producing malformed
		// BER and causing compliant SNMP agents to reject the discovery request.
		oidBytes := encodeOID(oid)
		varbindLen := 2 + len(oidBytes) + 2
		if varbindLen > 127 {
			// Current discovery OIDs use BER short-form lengths. Fail closed
			// rather than emit another malformed packet for a future long OID.
			continue
		}
		pdu.WriteByte(byte(varbindLen))
		// OID
		pdu.WriteByte(0x06)
		pdu.WriteByte(byte(len(oidBytes)))
		pdu.Write(oidBytes)
		// NULL value
		pdu.Write([]byte{0x05, 0x00})
	}
	// fix varbind len
	vbLen := pdu.Len() - vbLenPos - 1
	pdu.Bytes()[vbLenPos] = byte(vbLen)
	// fix pdu len
	pduLen := pdu.Len() - pduLenPos - 1
	pdu.Bytes()[pduLenPos] = byte(pduLen)
	// Full message
	var msg bytes.Buffer
	msg.WriteByte(0x30)
	msgLenPos := msg.Len()
	msg.WriteByte(0)
	// version 0 (v1)
	msg.Write([]byte{0x02, 0x01, 0x00})
	// community "public"
	msg.Write([]byte{0x04, 0x06})
	msg.WriteString("public")
	msg.Write(pdu.Bytes())
	msgLen := msg.Len() - msgLenPos - 1
	msg.Bytes()[msgLenPos] = byte(msgLen)
	return msg.Bytes()
}

func encodeOID(s string) []byte {
	parts := strings.Split(s, ".")
	var out []byte
	for i, p := range parts {
		var v int
		fmt.Sscanf(p, "%d", &v)
		if i == 0 {
			continue
		}
		if i == 1 {
			var first int
			fmt.Sscanf(parts[0], "%d", &first)
			out = append(out, byte(first*40+v))
			continue
		}
		// base128
		if v < 128 {
			out = append(out, byte(v))
		} else {
			out = append(out, byte(0x80|(v>>7)), byte(v&0x7F))
		}
	}
	return out
}

func extractSNMPString(data []byte) string {
	// The community is also an OCTET STRING. Decode the response envelope
	// and select the requested sysDescr varbind instead of scanning raw bytes.
	decoder := &gosnmp.GoSNMP{Version: gosnmp.Version1}
	packet, err := decoder.SnmpDecodePacket(data)
	if err != nil || packet == nil || packet.PDUType != gosnmp.GetResponse || packet.RequestID != 1 || packet.Community != "public" || packet.Version != gosnmp.Version1 || packet.Error != 0 {
		return ""
	}
	for _, variable := range packet.Variables {
		if strings.TrimPrefix(variable.Name, ".") == oidSysDescr && variable.Type == gosnmp.OctetString {
			return strings.TrimSpace(extractSNMPPDUString(variable))
		}
	}
	return ""
}

// LPR discovery: safe LPD probe on TCP 515.
// Sends the read-only long queue-status command (04), never a receive-job command.
func discoverLPRPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets) == 0 {
		return nil
	}
	const workers = 16
	const perHostTimeout = 800 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for host := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if di := probeLPRHost(ctx, host, perHostTimeout); di != nil {
					select {
					case results <- *di:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	for _, t := range targets {
		jobs <- t
	}
	close(jobs)
	// See discoverSNMPPrinters: never close(results) while a worker may
	// still hold the send. probeLPRHost's conn deadline starts at call
	// time, so every worker returns within ~800ms of ctx expiry.
	wg.Wait()
	close(results)
	var out []DeviceInfo
	seen := make(map[string]bool)
	for di := range results {
		k := dedupeKey(di)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, di)
	}
	return out
}

func probeLPRHost(ctx context.Context, host string, timeout time.Duration) *DeviceInfo {
	return probeLPRHostWithPort(ctx, host, 515, timeout)
}

func probeLPRHostWithPort(ctx context.Context, host string, port int, timeout time.Duration) *DeviceInfo {
	d := net.Dialer{Timeout: timeout}
	connCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := d.DialContext(connCtx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil
	}
	defer conn.Close()
	stopCancellation := context.AfterFunc(connCtx, func() { _ = conn.Close() })
	defer stopCancellation()
	deadline, _ := connCtx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil
	}
	// RFC 1179 section 5.4 returns a text stream, not a receive-job ACK.
	if _, err := conn.Write([]byte("\x04raw\n")); err != nil {
		return nil
	}
	buf := make([]byte, 256)
	n, readErr := conn.Read(buf)
	textResponse := n > 0
	for _, ch := range buf[:n] {
		if (ch < 32 && ch != '\n' && ch != '\r' && ch != '\t') || ch > 126 {
			textResponse = false
			break
		}
	}
	caps := map[string]interface{}{"discovered_via": SourceLPR, "queue": "raw", "verification": "candidate_only", "lpr_verified": false}
	if textResponse {
		caps["queue_status_response"] = strings.TrimSpace(string(buf[:n]))
	} else if readErr != nil && readErr != io.EOF {
		caps["probe_error"] = readErr.Error()
	} else {
		caps["probe_error"] = "Queue status was empty or was not an ASCII stream"
	}
	// An open port or queue-status response cannot prove the queue exists or
	// that it is routable. Keep the candidate visible with unknown health.
	id := StableIDFromNetwork(host, port)
	return &DeviceInfo{
		ID:             id,
		Name:           fmt.Sprintf("LPR Printer %s", host),
		DisplayName:    fmt.Sprintf("LPR Printer %s", host),
		ConnectionType: "network",
		Protocol:       "lpr",
		Endpoint:       net.JoinHostPort(host, strconv.Itoa(port)),
		NetworkAddress: host,
		Port:           port,
		Status:         "unknown",
		Enabled:        true,
		Capabilities:   caps,
	}
}

// WSD discovery is implemented in wsd_discovery.go
