package printer

import (
	"errors"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/yaseir-agent/agent/internal/config"
)

func TestLocalDiagnosticDoesNotSendToUnverifiedTCPListener(t *testing.T) {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	var listener net.Listener
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if !ok || network.IP.To4() == nil || !config.IsAllowedPrinterIP(network.IP) {
			continue
		}
		listener, err = net.Listen("tcp", net.JoinHostPort(network.IP.String(), "9100"))
		if err == nil {
			break
		}
	}
	if listener == nil {
		t.Skip("requires a local private IPv4 interface with TCP 9100 available")
	}
	defer listener.Close()
	_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(5 * time.Second))
	received := make(chan []byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			received <- nil
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		data, _ := io.ReadAll(conn)
		received <- data
	}()
	pc := config.PrinterConfig{ID: "unverified_diagnostic", Name: "Unverified TCP sink", Type: "network", Protocol: "raw", Endpoint: listener.Addr().String()}
	err = TestPrinter(&config.Config{Printers: []config.PrinterConfig{pc}}, filepath.Join(t.TempDir(), "printers.json"), pc.ID)
	_ = listener.Close()
	if data := <-received; len(data) != 0 {
		t.Errorf("unverified listener received %d diagnostic bytes", len(data))
	}
	if !errors.Is(err, ErrPrinterUnverified) {
		t.Fatalf("unverified local diagnostic error = %v, want PRINTER_UNVERIFIED", err)
	}
}
