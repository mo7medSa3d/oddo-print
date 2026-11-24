package printer

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func ippNoMediaFixture() []byte {
	var b bytes.Buffer
	b.Write([]byte{2, 0, 0, 0, 0, 0, 0, 1, 1})
	writeIPPAttribute(&b, 0x47, "attributes-charset", "utf-8")
	writeIPPAttribute(&b, 0x48, "attributes-natural-language", "en")
	b.WriteByte(4)
	writeIPPAttribute(&b, 0x49, "document-format-supported", ippFormatPDF)
	b.WriteByte(3)
	return b.Bytes()
}

func TestIPPRequestsMeasuredMediaAndResolution(t *testing.T) {
	request := buildIPPGetPrinterAttributes("ipp://printer.local/ipp/print")
	for _, name := range []string{"media-supported", "media-ready", "media-default", "media-col-default", "media-col-ready", "media-col-database", "printer-resolution-supported", "printer-resolution-default", "print-scaling-supported"} {
		if !bytes.Contains(request, []byte(name)) {
			t.Errorf("missing actual capability request: %s", name)
		}
	}
}

func TestIPPRasterNeverInventsMissingResolutionOrColor(t *testing.T) {
	for _, attrs := range []map[string]string{nil,
		{"pwg-raster-document-resolution-supported": "203x203dpi"},
		{"pwg-raster-document-type-supported": "sgray_8"},
	} {
		if dpi, mode, err := pwgOptionsFromIPPAttributes(attrs); err == nil {
			t.Errorf("invented PWG capability from %v: dpi=%d mode=%d", attrs, dpi, mode)
		}
	}
}

func TestIPPUnknownMediaRefusesBeforeDocumentTransmission(t *testing.T) {
	var submissions atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(r.Body)
		w.Header().Set("Content-Type", "application/ipp")
		if len(body) >= 8 && binary.BigEndian.Uint16(body[2:4]) == 0x000b {
			_, _ = w.Write(ippNoMediaFixture())
			return
		}
		submissions.Add(1)
		_, _ = w.Write(ippAcceptedJobResponse(0, 3))
	}))
	defer server.Close()
	p, err := NewIPPPrinter(server.URL, "unknown media")
	if err != nil {
		t.Fatal(err)
	}
	err = p.PrintDocument(context.Background(), Document{Kind: KindPDF, Data: validPDF()})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "media") || OutcomeUnknown(err) {
		t.Errorf("unknown media must fail safely before submission: %v", err)
	}
	if got := submissions.Load(); got != 0 {
		t.Errorf("sent %d document(s) without a measured supported media size", got)
	}
}

func ippMeasuredMediaFixture() []byte {
	b := bytes.NewBuffer(ippNoMediaFixture())
	b.Truncate(b.Len() - 1)
	writeIPPAttribute(b, 0x34, "media-col-default", "")
	writeIPPAttribute(b, 0x4a, "", "media-size")
	writeIPPAttribute(b, 0x34, "", "")
	writeIPPAttribute(b, 0x4a, "", "x-dimension")
	writeIPPIntAttr(b, 0x21, "", 8000)
	writeIPPAttribute(b, 0x4a, "", "y-dimension")
	writeIPPIntAttr(b, 0x21, "", 20000)
	writeIPPAttribute(b, 0x37, "", "")
	for _, margin := range []string{"media-left-margin", "media-right-margin", "media-top-margin", "media-bottom-margin"} {
		writeIPPAttribute(b, 0x4a, "", margin)
		writeIPPIntAttr(b, 0x21, "", 400)
	}
	writeIPPAttribute(b, 0x37, "", "")
	b.WriteByte(3)
	return b.Bytes()
}

func TestIPPMediaCollectionIsRetainedWithoutLeakingMembers(t *testing.T) {
	attrs, err := parseIPPPrinterAttributes(ippMeasuredMediaFixture(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if attrs["media-col-default"] == "" {
		t.Fatal("actual paper dimensions and margins were discarded")
	}
	if attrs["x-dimension"] != "" || attrs["media-left-margin"] != "" {
		t.Fatal("collection member escaped to top-level capabilities")
	}
}
