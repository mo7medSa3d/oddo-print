package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func sharingTestQueue(id, name string) PrinterConfig {
	return PrinterConfig{ID: id, Name: "Operator label", Type: "spooler", Protocol: "spooler", SpoolerName: name}
}

func TestPrinterSharingLegacyAbsentAndIndependentAtomicChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	pc := sharingTestQueue("local", "POS80")
	policy, err := LoadPrinterSharing(path)
	if err != nil || policy.Present {
		t.Fatalf("absent policy: %+v %v", policy, err)
	}
	if shared, err := policy.Shared(PrinterConfig{}, nil); err != nil || !shared {
		t.Fatalf("legacy absence: %v %v", shared, err)
	}
	if err := os.WriteFile(path, []byte("# local config must stay unchanged\nprinters: []\n"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetPrinterSharing(path, pc, []PrinterConfig{pc}, false); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterSharing(path)
	if err != nil || !policy.Present || policy.Version != 1 {
		t.Fatalf("durable policy: %+v %v", policy, err)
	}
	if shared, err := policy.Shared(pc, []PrinterConfig{pc}); err != nil || shared {
		t.Fatalf("unshare: %v %v", shared, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(before) {
		t.Fatalf("sharing mutated config: %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(PrinterSharingPath(path))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("unprotected policy: %v %v", info, err)
		}
	}
	if err := SetPrinterSharing(path, pc, []PrinterConfig{pc}, true); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterSharing(path)
	if err != nil || !policy.Present || len(policy.DeniedPrinters) != 0 {
		t.Fatalf("reshared file must remain valid/present: %+v %v", policy, err)
	}
	if shared, err := policy.Shared(pc, nil); err != nil || !shared {
		t.Fatalf("reshare: %v %v", shared, err)
	}
	if shared, err := policy.Shared(PrinterConfig{}, nil); err == nil || shared {
		t.Fatalf("present policy must reject ambiguous execution: %v %v", shared, err)
	}
}

func TestPrinterSharingStrictMalformedPolicyNeverDefaultsShared(t *testing.T) {
	digest := strings.Repeat("a", 64)
	cases := []string{
		"", "null", "[]", `{}`, `{"version":2,"deniedPrinters":{}}`,
		`{"version":1,"deniedPrinters":null}`, `{"version":1,"deniedPrinters":{}} trailing`,
		`{"version":1,"version":1,"deniedPrinters":{}}`,
		`{"version":1,"deniedPrinters":{"local":"` + digest + `","local":"` + digest + `"}}`,
		`{"version":1,"deniedPrinters":{"local":"short"}}`,
		`{"version":1,"deniedPrinters":{"local":"` + strings.Repeat("A", 64) + `"}}`,
		`{"version":1,"deniedPrinters":{" ":"` + digest + `"}}`,
		`{"version":1,"deniedPrinters":{"bad\nID":"` + digest + `"}}`,
		`{"version":1,"deniedPrinters":{},"shared":true}`,
		`{"version":1,"deniedPrinters":{},"deniedPrinterAliases":null}`,
		`{"version":1,"deniedPrinters":{},"deniedPrinterAliases":{"orphan":["` + digest + `"]}}`,
		`{"version":1,"deniedPrinters":{"local":"` + digest + `"},"deniedPrinterAliases":{"local":[]}}`,
		`{"version":1,"deniedPrinters":{"local":"` + digest + `"},"deniedPrinterAliases":{"local":["short"]}}`,
		`{"version":1,"deniedPrinters":{"local":"` + digest + `"},"deniedPrinterAliases":{"local":["` + digest + `","` + digest + `"]}}`,
		`{"version":1,"deniedPrinters":{"local":"` + digest + `"},"deniedPrinterAliases":{"local":["` + digest + `"],"local":["` + digest + `"]}}`,
	}
	for i, data := range cases {
		t.Run(strings.Repeat("x", i+1), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "agent.yaml")
			if err := os.WriteFile(PrinterSharingPath(path), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadPrinterSharing(path); err == nil {
				t.Fatal("malformed policy accepted")
			}
			if err := SetPrinterSharing(path, sharingTestQueue("local", "POS80"), nil, true); err == nil {
				t.Fatal("mutation silently repaired/erased invalid denies")
			}
			after, err := os.ReadFile(PrinterSharingPath(path))
			if err != nil || string(after) != data {
				t.Fatalf("malformed policy overwritten: %v", err)
			}
		})
	}
}

func TestPrinterSharingRejectsNonRegularAndOversizePolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.Mkdir(PrinterSharingPath(path), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPrinterSharing(path); err == nil {
		t.Fatal("directory policy accepted")
	}
	if err := os.Remove(PrinterSharingPath(path)); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(PrinterSharingPath(path))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxPrinterSharingBytes + 1); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPrinterSharing(path); err == nil {
		t.Fatal("oversize policy accepted")
	}
}

func TestPrinterSharingBindingAliasesRenameAndReshare(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	local := sharingTestQueue("stable", "Receipt queue")
	alias := sharingTestQueue("cloud-alias", " RECEIPT QUEUE ")
	other := sharingTestQueue("other", "Separate receipt queue")
	other.USBSerial, local.USBSerial = "same-hardware", "same-hardware"
	if err := SetPrinterSharing(path, local, nil, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(alias, []PrinterConfig{local}); err != nil || shared {
		t.Fatalf("alias bypass: %v %v", shared, err)
	}
	if shared, err := policy.Shared(other, []PrinterConfig{local, other}); err != nil || !shared {
		t.Fatalf("distinct named queue incorrectly merged by hardware: %v %v", shared, err)
	}
	renamed := sharingTestQueue("stable", "New native queue name")
	renamedAlias := sharingTestQueue("new-cloud-id", "New native queue name")
	if shared, err := policy.Shared(renamed, []PrinterConfig{renamed}); err != nil || shared {
		t.Fatalf("stable rename bypass: %v %v", shared, err)
	}
	if shared, err := policy.Shared(renamedAlias, []PrinterConfig{renamed}); err != nil || shared {
		t.Fatalf("current denied binding bypass: %v %v", shared, err)
	}
	if err := SetPrinterSharing(path, renamedAlias, []PrinterConfig{renamed}, true); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(policy.DeniedPrinters) != 0 {
		t.Fatalf("reshare did not remove current same-binding deny: %+v", policy)
	}
}

func TestPrinterSharingPrivacyActiveNativeAdmissionRequiresIndependentLocalBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	local := sharingTestQueue("stable", "Private POS80")
	unknown := sharingTestQueue("cloud-only", `\\host.example.test\NativeShare`)
	if err := SetPrinterSharing(path, local, nil, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(unknown, []PrinterConfig{local}); err != nil || shared {
		t.Fatalf("unobserved cloud native destination self-authorized: %v %v", shared, err)
	}
	manual := unknown
	manual.Capabilities = map[string]interface{}{"registration_source": "manual", "verification": "candidate_only"}
	if shared, err := policy.Shared(unknown, []PrinterConfig{local, manual}); err != nil || !shared {
		t.Fatalf("explicit local remote registration removed: %v %v", shared, err)
	}
	candidate := unknown
	candidate.Capabilities = map[string]interface{}{"verification": "candidate_only"}
	if shared, err := policy.Shared(unknown, []PrinterConfig{local, candidate}); err != nil || shared {
		t.Fatalf("setup-only observation authorized a native destination: %v %v", shared, err)
	}
	// No DNS suffix/host guess equates these independently selected queues.
	if shared, err := policy.Shared(unknown, []PrinterConfig{local, sharingTestQueue("short", `\\host\NativeShare`)}); err != nil || shared {
		t.Fatalf("short hostname invented FQDN authority: %v %v", shared, err)
	}
	if err := SetPrinterSharing(path, local, nil, true); err != nil {
		t.Fatal(err)
	}
	policy, err = LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	if shared, err := policy.Shared(unknown, nil); err != nil || !shared {
		t.Fatalf("empty opt-out policy changed valid legacy setup: %v %v", shared, err)
	}
}

func TestPrinterBindingDigestExecutionNormalization(t *testing.T) {
	tcp := PrinterConfig{ID: "tcp", Type: "network", Protocol: "raw", Endpoint: "192.168.1.10:9100"}
	escpos := tcp
	escpos.ID = "another"
	escpos.Protocol = "escpos"
	escpos.Name = "different label"
	ipv6 := tcp
	ipv6.Endpoint = "[fd00:0:0:0:0:0:0:10]:9100"
	ipv6Alias := ipv6
	ipv6Alias.Endpoint = "[fd00::10]:9100"
	ipp := PrinterConfig{Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.10/Queues/Front"}
	ippAlias := ipp
	ippAlias.Endpoint = "http://192.168.1.10:631/Queues/Front"
	ippOther := ipp
	ippOther.Endpoint = "ipp://192.168.1.10/queues/front"
	usb := PrinterConfig{Type: "usb", Protocol: "raw", Endpoint: `\\?\usb#vid_1234&pid_5678#unique_instance`, USBVID: "1234", USBPID: "5678"}
	usbOther := usb
	usbOther.Endpoint = `\\?\usb#vid_1234&pid_5678#another_instance`
	for _, pair := range [][2]PrinterConfig{{tcp, escpos}, {ipv6, ipv6Alias}, {ipp, ippAlias}, {sharingTestQueue("a", "Cafe\u0301"), sharingTestQueue("b", "CAFÉ")}} {
		left, err := PrinterBindingDigest(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		right, err := PrinterBindingDigest(pair[1])
		if err != nil || left != right {
			t.Fatalf("equivalent bindings differ: %q %q %v", left, right, err)
		}
	}
	for _, pair := range [][2]PrinterConfig{{ipp, ippOther}, {usb, usbOther}} {
		left, err := PrinterBindingDigest(pair[0])
		if err != nil {
			t.Fatal(err)
		}
		right, err := PrinterBindingDigest(pair[1])
		if err != nil || left == right {
			t.Fatalf("distinct execution destinations merged: %v", err)
		}
	}
	ambiguous := usb
	ambiguous.Endpoint = ""
	ambiguous.USBSerial = ""
	if _, err := PrinterBindingDigest(ambiguous); err == nil {
		t.Fatal("USB VID/PID alone selected a physical destination")
	}
}

func TestPrinterSharingConcurrentChoicesNeverLoseOtherDenies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := strings.Repeat("q", i+1)
			errors <- SetPrinterSharing(path, sharingTestQueue(id, id), nil, false)
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	policy, err := LoadPrinterSharing(path)
	if err != nil || len(policy.DeniedPrinters) != 8 {
		t.Fatalf("lost independent denied IDs: %+v %v", policy, err)
	}
}

func TestPrinterSharingDiscoveryUnknownLanguageMatchesPrivateEndpointOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.yaml")
	pc := PrinterConfig{ID: "local", Type: "network", Protocol: "raw", Endpoint: "192.168.1.10:9100"}
	if err := SetPrinterSharing(path, pc, nil, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	candidate := pc
	candidate.ID, candidate.Protocol = "candidate", "unknown"
	if policy.DiscoveryShared(candidate, nil) {
		t.Fatal("missing byte language leaked the same private TCP endpoint")
	}
	if shared, err := policy.Shared(candidate, nil); err == nil || shared {
		t.Fatal("discovery privacy comparison granted unknown-language execution")
	}
	candidate.Endpoint = "192.168.1.11:9100"
	if !policy.DiscoveryShared(candidate, nil) {
		t.Fatal("unrelated unknown-language candidate suppressed")
	}
	candidate.Endpoint = ""
	if !policy.DiscoveryShared(candidate, nil) {
		t.Fatal("unidentifiable unrelated setup observation suppressed")
	}
}

func TestPrinterSharingIPPPathAliasesKeepCaseAndReservedQueueSegments(t *testing.T) {
	pc := PrinterConfig{ID: "local", Type: "ipp", Protocol: "ipp", Endpoint: "ipp://192.168.1.10/Queues/Front"}
	path := filepath.Join(t.TempDir(), "agent.yaml")
	if err := SetPrinterSharing(path, pc, nil, false); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPrinterSharing(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{"http://192.168.1.10:631/%51ueues/Front", "ipp://192.168.1.10/Queues/./Front", "ipp://192.168.1.10/Queues/Unused/../Front", "ipp://192.168.1.10/Queues/%2e/Front"} {
		alias := pc
		alias.ID, alias.Endpoint = "alias", uri
		if shared, err := policy.Shared(alias, nil); err != nil || shared {
			t.Fatalf("equivalent URI bypassed private queue: %s shared=%v %v", uri, shared, err)
		}
	}
	for _, pair := range [][2]string{{"/Queues/A%2FB", "/Queues/A/B"}, {"/Queues/Front", "/queues/front"}, {"/Queues//Front", "/Queues/Front"}} {
		left, right := pc, pc
		left.Endpoint = "ipp://192.168.1.10" + pair[0]
		right.Endpoint = "ipp://192.168.1.10" + pair[1]
		leftDigest, err := PrinterBindingDigest(left)
		if err != nil {
			t.Fatal(err)
		}
		rightDigest, err := PrinterBindingDigest(right)
		if err != nil || leftDigest == rightDigest {
			t.Fatalf("distinct queue path semantics merged: %v %v", pair, err)
		}
	}
	left, right := pc, pc
	left.Endpoint = "ipp://192.168.1.10/Queues/A%2fB"
	right.Endpoint = "ipp://192.168.1.10/Queues/A%2FB"
	leftDigest, err := PrinterBindingDigest(left)
	if err != nil {
		t.Fatal(err)
	}
	rightDigest, err := PrinterBindingDigest(right)
	if err != nil || leftDigest != rightDigest {
		t.Fatalf("percent-escape case bypass: %v", err)
	}
}
