package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

type gatewayBodyObservedReader struct {
	input     io.Reader
	bytesRead int
	sawEOF    bool
}

func (r *gatewayBodyObservedReader) Read(buffer []byte) (int, error) {
	n, err := r.input.Read(buffer)
	r.bytesRead += n
	r.sawEOF = r.sawEOF || errors.Is(err, io.EOF)
	return n, err
}

type gatewayBodyFailureReader struct {
	err error
}

func (r gatewayBodyFailureReader) Read(buffer []byte) (int, error) {
	return copy(buffer, `{"truncated":`), r.err
}

func TestGatewayRequestStdinPreservesEmptyAndExactLimitBodies(t *testing.T) {
	for _, body := range []string{"", `{"name":"Receipt Queue"}`, strings.Repeat("x", gatewayRequestMaxBody)} {
		reader := &gatewayBodyObservedReader{input: strings.NewReader(body)}
		got, err := gatewayRequestBody("", false, true, reader)
		if err != nil || got != body || reader.bytesRead != len(body) || !reader.sawEOF {
			t.Fatalf("stdin completion changed or truncated accepted body: size=%d read=%d EOF=%v err=%v", len(body), reader.bytesRead, reader.sawEOF, err)
		}
	}
}

func TestGatewayRequestStdinPreservesLargeMultibyteJSON(t *testing.T) {
	body := `{"name":"` + strings.Repeat("طابعة", 20000) + `"}`
	got, err := gatewayRequestBody("", false, true, strings.NewReader(body))
	if err != nil || got != body {
		t.Fatalf("large Unicode body did not pass unchanged through stdin: size=%d err=%v", len(body), err)
	}
}

func TestGatewayRequestStdinRejectsOversizeWithoutReadingRemainder(t *testing.T) {
	body := strings.Repeat("x", gatewayRequestMaxBody+128)
	reader := &gatewayBodyObservedReader{input: strings.NewReader(body)}
	got, err := gatewayRequestBody("", false, true, reader)
	if err == nil || got != "" || reader.bytesRead != gatewayRequestMaxBody+1 || reader.sawEOF {
		t.Fatalf("oversized stdin was accepted/truncated or consumed unbounded input: size=%d read=%d EOF=%v err=%v", len(got), reader.bytesRead, reader.sawEOF, err)
	}
	if _, err := gatewayRequestBody(strings.Repeat("ط", gatewayRequestMaxBody/2+1), true, false, nil); err == nil {
		t.Fatal("legacy argv limit must count UTF-8 bytes, not Unicode characters")
	}
}

func TestGatewayRequestStdinReadFailureCannotForwardPartialBody(t *testing.T) {
	wantErr := errors.New("input stream interrupted")
	got, err := gatewayRequestBody("", false, true, gatewayBodyFailureReader{err: wantErr})
	if got != "" || !errors.Is(err, wantErr) {
		t.Fatalf("partial stream became an accepted body or lost its read error: body=%q err=%v", got, err)
	}
	if _, err := gatewayRequestBody("", false, true, nil); err == nil {
		t.Fatal("unavailable selected stdin must fail explicitly")
	}
}

func TestGatewayRequestBodySourcesAreExclusiveAndLegacyIsPreserved(t *testing.T) {
	for _, argv := range []string{"", `{"name":"Legacy Queue"}`} {
		reader := &gatewayBodyObservedReader{input: strings.NewReader(`{"name":"stdin Queue"}`)}
		if got, err := gatewayRequestBody(argv, true, true, reader); err == nil || got != "" || reader.bytesRead != 0 {
			t.Fatalf("conflicting body sources selected one or consumed stdin: body=%q read=%d err=%v", got, reader.bytesRead, err)
		}
		got, err := gatewayRequestBody(argv, true, false, gatewayBodyFailureReader{err: errors.New("must not read")})
		if err != nil || got != argv {
			t.Fatalf("legacy argv body changed or consumed stdin: body=%q err=%v", got, err)
		}
	}
}

func TestGatewayRequestExplicitEmptyBodyConflictsBeforeConfigOrHTTP(t *testing.T) {
	const childFlag = "YASEIR_TEST_GATEWAY_BODY_CHILD"
	if os.Getenv(childFlag) == "1" {
		args := os.Args
		for i, arg := range args {
			if arg == "--" {
				handleGatewayRequest(args[i+1:], "unused-config-must-not-be-read")
				return
			}
		}
		t.Fatal("child invocation missing argument boundary")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestGatewayRequestExplicitEmptyBodyConflictsBeforeConfigOrHTTP$", "--", "-path", "/api/printers", "-body", "", "-body-stdin")
	cmd.Env = append(os.Environ(), childFlag+"=1")
	cmd.Stdin = strings.NewReader(`{"name":"must not forward"}`)
	output, err := cmd.CombinedOutput()
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 2 || !strings.Contains(string(output), "mutually exclusive") {
		t.Fatalf("real CLI flags failed to reject explicit empty -body before config/network: output=%q err=%v", output, err)
	}
	if strings.Contains(string(output), "load agent config") || strings.Contains(string(output), "Gateway request failed") {
		t.Fatalf("conflicting body reached configuration or HTTP: %s", output)
	}
}

func TestGatewayResponseProducerFitsEscapedEnvelopeBudget(t *testing.T) {
	body := bytes.Repeat([]byte("<"), gatewayRequestMaxBody)
	headers := make(http.Header)
	wantHeaders := make(map[string]string)
	for _, key := range []string{"x-has-more", "x-next-before-created-at", "x-next-before-id-encoded", "x-next-before-id", "x-next-cursor"} {
		value := strings.Repeat("&", gatewayPaginationHeaderMaxBytes)
		headers.Set(key, value)
		wantHeaders[key] = value
	}
	encoded, err := encodeGatewayResponse(207, body, headers)
	if err != nil {
		t.Fatal(err)
	}
	const envelopeBudget = 6 * (gatewayRequestMaxBody + 64*1024)
	if len(encoded) <= gatewayRequestMaxBody || len(encoded)+1 > envelopeBudget {
		t.Fatalf("actual Go producer escaping exceeds the IPC budget or regression does not cover argv/body expansion: encoded=%d budget=%d", len(encoded), envelopeBudget)
	}
	var roundtrip struct {
		Status  uint16            `json:"status"`
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if roundtrip.Status != 207 || roundtrip.Body != string(body) || !reflect.DeepEqual(roundtrip.Headers, wantHeaders) {
		t.Fatal("bounded envelope producer changed HTTP status, body or continuation metadata")
	}
	headers.Set("X-Next-Cursor", strings.Repeat("x", gatewayPaginationHeaderMaxBytes+1))
	if encoded, err := encodeGatewayResponse(207, []byte("valid response"), headers); err == nil || encoded != nil {
		t.Fatal("invalid continuation metadata emitted a success/partial stdout envelope")
	}
}
