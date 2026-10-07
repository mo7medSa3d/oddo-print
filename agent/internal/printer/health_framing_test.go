package printer

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

type scriptedHealthChannel struct {
	reader *bytes.Reader
}

func (c scriptedHealthChannel) Read(data []byte) (int, error) {
	return c.reader.Read(data)
}

func (c scriptedHealthChannel) Write(data []byte) (int, error) {
	return len(data), nil
}

var _ io.ReadWriter = scriptedHealthChannel{}

func TestInvalidStatusFramingCannotAssertHardwareFaults(t *testing.T) {
	for _, replies := range [][]byte{
		{0xff}, {0x08}, {0x1b},
		{0x12, 0xff}, {0x12, 0x04}, {0x12, 0x20}, {0x12, 0x40},
		{0x12, 0x12, 0xff}, {0x12, 0x12, 0x20}, {0x12, 0x12, 0x60},
	} {
		status, err := QueryHealthStatus(scriptedHealthChannel{bytes.NewReader(replies)})
		if !errors.Is(err, ErrPrinterStatusUnsupported) || status != nil {
			t.Errorf("invalid frame %x produced hardware evidence %v, error %v", replies, status, err)
		}
		if errors.Is(err, ErrPrinterOffline) || errors.Is(err, ErrPrinterCoverOpen) || errors.Is(err, ErrPrinterPaperOut) {
			t.Errorf("invalid frame %x invented a hardware fault: %v", replies, err)
		}
	}
}

func TestValidStatusFramingPreservesHardwareFaults(t *testing.T) {
	for _, test := range []struct {
		replies []byte
		want    error
	}{
		{[]byte{0x1a}, ErrPrinterOffline},
		{[]byte{0x12, 0x16}, ErrPrinterCoverOpen},
		{[]byte{0x12, 0x32}, ErrPrinterPaperOut},
		{[]byte{0x12, 0x52}, ErrPrinterOffline},
		{[]byte{0x12, 0x12, 0x72}, ErrPrinterPaperOut},
	} {
		status, err := QueryHealthStatus(scriptedHealthChannel{bytes.NewReader(test.replies)})
		if status == nil || !errors.Is(err, test.want) {
			t.Errorf("valid fault frame %x: status %v, error %v; want %v", test.replies, status, err, test.want)
		}
	}
}
