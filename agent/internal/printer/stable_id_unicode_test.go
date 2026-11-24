package printer

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

// These tests pin the identity layer to Unicode NFC folding.
//
// Unicode lets the same visible text be encoded two ways: composed (NFC) or
// decomposed (NFD, base letter plus a combining mark). Arabic is especially
// exposed because diacritics such as shadda (U+0651) and hamza (U+0654) are
// separate combining marks, and a queue name pasted from a source that emits
// NFD is byte-different from the NFC form Windows returns.
//
// Before the fix, hashing the two encodings produced two different stable IDs,
// so one physical printer was inventoried twice.
//
// Reference: https://unicode.org/reports/tr15/

// Both strings render identically as "طابعة الفرع الرئيسي".
//
// They are written as explicit \u escapes on purpose: the difference between
// them is a single precomposed character versus a base letter plus a combining
// mark, and a combining mark is invisible in source. Escapes keep the fixture
// exact and reviewable.
//
//	nfcName: ... U+0631 (reh) U+0626 (yeh WITH hamza above, precomposed) U+064A U+0633 U+064A
//	nfdName: ... U+0631 (reh) U+064A (yeh) U+0654 (combining hamza above) U+064A U+0633 U+064A
const (
	arQueuePrefix = "طابعة الفرع "
	nfcName       = arQueuePrefix + "\u0627\u0644\u0631\u0626\u064a\u0633\u064a"
	nfdName       = arQueuePrefix + "\u0627\u0644\u0631\u064a\u0654\u064a\u0633\u064a"
)

func TestUnicodeFixturesAreCanonicallyEquivalentButByteDifferent(t *testing.T) {
	// Guard the fixtures themselves: if these ever collapse to the same byte
	// sequence the tests below would pass trivially and prove nothing.
	if !norm.NFC.IsNormalString(nfcName) {
		t.Fatalf("fixture nfcName is not in NFC; the fixture is wrong")
	}
	if nfdName == nfcName {
		t.Fatalf("fixture nfdName is byte-identical to nfcName; it must exercise the decomposed form")
	}
	if got := norm.NFC.String(nfdName); got != nfcName {
		t.Fatalf("fixtures are not canonically equivalent: NFC(%q)=%q want %q", nfdName, got, nfcName)
	}
}

func TestStableIDFromSpoolerFoldsUnicodeNormalization(t *testing.T) {
	nfcID := StableIDFromSpooler(nfcName)
	nfdID := StableIDFromSpooler(nfdName)
	if nfcID != nfdID {
		t.Fatalf("one printer produced two IDs across Unicode normalization forms:\n  NFC %q -> %s\n  NFD %q -> %s",
			nfcName, nfcID, nfdName, nfdID)
	}
}

func TestStableIDFromSpoolerPreservesExistingNFCIDs(t *testing.T) {
	// Folding must be a no-op for names already in NFC, otherwise every
	// existing printer binding would change on upgrade.
	for _, name := range []string{"HP LaserJet 400", nfcName, "طابعة الاستقبال", "POS-01"} {
		if !norm.NFC.IsNormalString(name) {
			t.Fatalf("test input %q is not NFC; pick a different input", name)
		}
		// Independently recompute what the ID must be without the fold.
		want := stableIDFromSpoolerUnfolded(name)
		if got := StableIDFromSpooler(name); got != want {
			t.Fatalf("NFC input %q changed ID under folding: got %s want %s", name, got, want)
		}
	}
}

// stableIDFromSpoolerUnfolded reproduces the historical (pre-fix) computation
// so the backward-compatibility assertion above is a real check rather than a
// restatement of the implementation under test. It deliberately does NOT call
// normalizeUnicode.
func stableIDFromSpoolerUnfolded(spoolerName string) string {
	n := strings.ToLower(strings.TrimSpace(spoolerName))
	n = strings.ReplaceAll(n, " ", "_")
	sum := sha256.Sum256([]byte("spooler:" + n))
	return fmt.Sprintf("printer_spooler_%x", sum[:8])
}

func TestStableIDForDeviceFoldsUnicodeSpoolerName(t *testing.T) {
	nfcDev := DeviceInfo{Name: nfcName, SpoolerName: nfcName, ConnectionType: "spooler", Protocol: "spooler"}
	nfdDev := DeviceInfo{Name: nfdName, SpoolerName: nfdName, ConnectionType: "spooler", Protocol: "spooler"}
	if got, want := StableIDForDevice(nfdDev), StableIDForDevice(nfcDev); got != want {
		t.Fatalf("device identity split across Unicode normalization forms: NFC=%s NFD=%s", want, got)
	}
}

func TestStableIDForDeviceFoldsUnicodeNameFallback(t *testing.T) {
	// No spooler name, no durable identity: the display name is the last
	// fallback and must be folded too.
	nfcDev := DeviceInfo{Name: nfcName}
	nfdDev := DeviceInfo{Name: nfdName}
	if got, want := StableIDForDevice(nfdDev), StableIDForDevice(nfcDev); got != want {
		t.Fatalf("name-fallback identity split across Unicode normalization forms: NFC=%s NFD=%s", want, got)
	}
}

func TestStableIDFromEndpointFoldsUnicodeHost(t *testing.T) {
	// Build the endpoint from the verified fixture so the test actually
	// exercises a decomposable label instead of skipping.
	nfcEP := "ipp://" + nfcName + ".example.com/ipp/print"
	nfdEP := "ipp://" + nfdName + ".example.com/ipp/print"
	if nfcEP == nfdEP {
		t.Fatalf("endpoint fixture carries no decomposable characters; the test would prove nothing")
	}
	if got := norm.NFC.String(nfdEP); got != nfcEP {
		t.Fatalf("endpoint fixtures are not canonically equivalent: NFC(NFD)=%q want %q", got, nfcEP)
	}
	if got, want := StableIDFromEndpoint(nfdEP), StableIDFromEndpoint(nfcEP); got != want {
		t.Fatalf("endpoint identity split across Unicode normalization forms: NFC=%s NFD=%s", want, got)
	}
}

func TestNormalizeUnicodeIsIdempotentAndEmptySafe(t *testing.T) {
	if got := normalizeUnicode(""); got != "" {
		t.Fatalf("normalizeUnicode(\"\") = %q, want empty", got)
	}
	once := normalizeUnicode(nfdName)
	twice := normalizeUnicode(once)
	if once != twice {
		t.Fatalf("normalizeUnicode is not idempotent: %q then %q", once, twice)
	}
	if once != nfcName {
		t.Fatalf("normalizeUnicode(NFD) = %q, want NFC form %q", once, nfcName)
	}
	if !norm.NFC.IsNormalString(once) {
		t.Fatalf("normalizeUnicode did not produce NFC output")
	}
}

func TestStableIDFromUSBFullFoldsSerial(t *testing.T) {
	// USB serials are ASCII in practice, but the fold must not break them
	// and must still collapse a decomposed serial if one ever appears.
	nfc := StableIDFromUSBFull("04b8", "0202", "SN-AR-1", "", "")
	nfd := StableIDFromUSBFull("04b8", "0202", norm.NFD.String("SN-AR-1"), "", "")
	if nfc != nfd {
		t.Fatalf("USB serial identity split across Unicode normalization forms: %s vs %s", nfc, nfd)
	}
	if want := StableIDFromUSB("04b8", "0202", "SN-AR-1", ""); nfc != want {
		t.Fatalf("StableIDFromUSBFull disagrees with StableIDFromUSB: got %s want %s", nfc, want)
	}
}
