package printer

import (
	"context"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMP Printer-MIB / Host-Resources-MIB status channel.
//
// RAW TCP (9100) and most direct protocols are write-only byte sinks:
// today a reachable non-ESC/POS network printer can only ever report
// "unknown", because nothing reads device state back. Most network
// printers — office lasers almost universally, many POS/label devices
// — expose the standard Host Resources printer table over SNMP
// (RFC 2790): hrPrinterStatus plus hrPrinterDetectedErrorState, whose
// bit field names exactly the conditions operators care about (paper
// out, jam, door open, toner out/empty, tray missing, output full).
// When the device answers, that is real bidirectional status from the
// device itself; when it does not, the caller keeps its previous
// behavior. Nothing here invents state: every verdict traces to bits
// or an enum the device reported.
const (
	oidHrPrinterStatusTable        = "1.3.6.1.2.1.25.3.5.1.1"
	oidHrPrinterDetectedErrorTable = "1.3.6.1.2.1.25.3.5.1.2"
	oidHrPrinterStatus             = oidHrPrinterStatusTable + ".1"
	oidHrPrinterDetectedErrorState = oidHrPrinterDetectedErrorTable + ".1"
	hrPrinterStatusIdle            = 3
	hrPrinterStatusPrinting        = 4
	hrPrinterStatusWarmup          = 5
	snmpStatusProbeTimeout         = 500 * time.Millisecond
	snmpStatusProbeRetries         = 1
	snmpStatusUnsupportedCacheFor  = 10 * time.Minute
)

// hrErrorFaults are the DETECTED-ERROR bits that mean the device
// cannot print right now, in priority order. Bit positions follow
// RFC 2790: the bit string is MSB-first, so bit 0 (lowPaper) is 0x80
// of byte 0.
var hrErrorFaults = []struct {
	byteIdx int
	mask    byte
	detail  string
	offline bool
}{
	{0, 0x40, "snmp_no_paper", false},
	{0, 0x04, "snmp_paper_jam", false},
	{0, 0x08, "snmp_door_open", false},
	{0, 0x10, "snmp_no_toner", false},
	{1, 0x80, "snmp_input_tray_missing", false},
	{1, 0x20, "snmp_supply_missing", false},
	{1, 0x10, "snmp_output_full", false},
	{0, 0x01, "snmp_service_requested", false},
	{0, 0x02, "snmp_device_offline", true},
}

// hrErrorWarnings are detected-error bits that do NOT stop printing
// (low paper / low toner). They ride along as the status detail when
// the device is otherwise working, never as a blocking status.
var hrErrorWarnings = []struct {
	byteIdx int
	mask    byte
	detail  string
}{
	{0, 0x80, "snmp_low_paper"},
	{0, 0x20, "snmp_low_toner"},
}

func hrBit(errState []byte, byteIdx int, mask byte) bool {
	return byteIdx < len(errState) && errState[byteIdx]&mask != 0
}

// interpretSNMPPrinterStatus maps one Host-Resources printer-table
// reading onto the shared Gateway status vocabulary. Either input may
// be absent (devices implement the table unevenly); the verdict is ""
// when the evidence cannot support one, so the caller falls back to
// its existing behavior instead of printing a guess.
func interpretSNMPPrinterStatus(hrStatus int, hasHRStatus bool, errState []byte, hasErrState bool) (status, detail string) {
	if !hasHRStatus && !hasErrState {
		return "", ""
	}
	if hasErrState {
		for _, fault := range hrErrorFaults {
			if hrBit(errState, fault.byteIdx, fault.mask) {
				if fault.offline {
					return "offline", fault.detail
				}
				return "error", fault.detail
			}
		}
	}
	warning := ""
	if hasErrState {
		for _, w := range hrErrorWarnings {
			if hrBit(errState, w.byteIdx, w.mask) {
				warning = w.detail
				break
			}
		}
	}
	if hasHRStatus {
		switch hrStatus {
		case hrPrinterStatusIdle:
			if warning != "" {
				return "online", warning
			}
			return "online", "snmp_ok"
		case hrPrinterStatusPrinting:
			if warning != "" {
				return "busy", warning
			}
			return "busy", "snmp_printing"
		case hrPrinterStatusWarmup:
			return "busy", "snmp_warmup"
		}
	}
	// No usable hrPrinterStatus, but the device answered with an
	// error-state field that carries no fault: that is a positive
	// "no detected errors" report from the device, not an assumption.
	if hasErrState && len(errState) > 0 {
		if warning != "" {
			return "online", warning
		}
		return "online", "snmp_no_errors"
	}
	return "", ""
}

// probeSNMPPrinterStatus performs one bounded SNMPv2c read of the
// Host-Resources printer table on host (UDP 161, community "public" —
// the same read-only posture as discovery; never a configured private
// credential). ok=false means the device did not answer usefully and
// the caller must keep its existing status behavior.
func probeSNMPPrinterStatus(ctx context.Context, host string) (status, detail string, ok bool) {
	params, cancel := snmpClient(ctx, host, 161, snmpStatusProbeTimeout, snmpStatusProbeRetries)
	defer cancel()
	if err := params.Connect(); err != nil {
		return "", "", false
	}
	defer params.Conn.Close()
	result, err := params.Get([]string{oidHrPrinterStatus, oidHrPrinterDetectedErrorState})
	if err != nil || result == nil || result.Error != gosnmp.NoError {
		return "", "", false
	}
	var (
		hrStatus    int
		hasHRStatus bool
		errState    []byte
		hasErrState bool
	)
	for _, pdu := range result.Variables {
		switch strings.TrimPrefix(pdu.Name, ".") {
		case oidHrPrinterStatus:
			if v, isInt := pdu.Value.(int); isInt {
				hrStatus, hasHRStatus = v, true
			}
		case oidHrPrinterDetectedErrorState:
			switch v := pdu.Value.(type) {
			case []byte:
				errState, hasErrState = v, true
			case string:
				errState, hasErrState = []byte(v), true
			}
		}
	}
	status, detail = interpretSNMPPrinterStatus(hrStatus, hasHRStatus, errState, hasErrState)
	if status != "" {
		return status, detail, true
	}
	// Some MFPs assign hrDeviceIndex > 1 to the printer sub-device (RFC 3805 / RFC 2790).
	// Walk hrPrinterStatus only when .1 returned no usable status.
	walked, walkErr := params.WalkAll(oidHrPrinterStatusTable)
	if walkErr != nil {
		return "", "", false
	}
	for _, pdu := range walked {
		name := strings.TrimPrefix(pdu.Name, ".")
		suffix := strings.TrimPrefix(name, oidHrPrinterStatusTable+".")
		if suffix == "" || suffix == name || suffix == "1" {
			continue
		}
		v, isInt := pdu.Value.(int)
		if !isInt {
			continue
		}
		hrStatus, hasHRStatus = v, true
		errState, hasErrState = nil, false
		errRes, errGet := params.Get([]string{oidHrPrinterDetectedErrorTable + "." + suffix})
		if errGet == nil && errRes != nil && errRes.Error == gosnmp.NoError {
			for _, epdu := range errRes.Variables {
				switch ev := epdu.Value.(type) {
				case []byte:
					errState, hasErrState = ev, true
				case string:
					errState, hasErrState = []byte(ev), true
				}
			}
		}
		status, detail = interpretSNMPPrinterStatus(hrStatus, hasHRStatus, errState, hasErrState)
		if status != "" {
			return status, detail, true
		}
	}
	return "", "", false
}

// snmpStatusProbe is the probe seam tests replace; production code
// always goes through probeSNMPPrinterStatus.
var snmpStatusProbe = probeSNMPPrinterStatus
