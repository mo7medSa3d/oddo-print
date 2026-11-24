package printer

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Malformed Printer-MIB evidence must never authorize a reachable byte sink.
func TestSNMPProbeRequiresSuccessfulExactTypedIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		suffix string
		tag    gosnmp.Asn1BER
		status uint8
		want   bool
	}{
		{"valid", "", gosnmp.OctetString, 0, true},
		{"different_instance", ".1", gosnmp.OctetString, 0, false},
		{"wrong_type", "", gosnmp.ObjectIdentifier, 0, false},
		{"error_response", "", gosnmp.OctetString, 5, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			udp, err := net.ListenPacket("udp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer udp.Close()
			tcp, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer tcp.Close()
			done := make(chan struct{})
			// The rebound connected socket, handed to the test's cleanup
			// so the server goroutine can be stopped after the probe.
			reboundCh := make(chan *net.UDPConn, 1)
			go func() {
				defer close(done)
				buffer := make([]byte, 4096)
				codec := &gosnmp.GoSNMP{Version: gosnmp.Version2c, Community: "public"}
				// See TestSNMPParserAndProbe: replies must originate from
				// the port the client dialed, over a connected socket.
				// The first request triggers a rebind to a connected
				// socket on the same local port; its response is
				// sacrificed and the client's retry is answered.
				conn := udp
				rebound := false
				for {
					n, peer, err := conn.ReadFrom(buffer)
					if err != nil {
						return
					}
					req, err := codec.SnmpDecodePacket(buffer[:n])
					if err != nil {
						return
					}
					if !rebound {
						peerAddr, ok := peer.(*net.UDPAddr)
						if !ok {
							return
						}
						// Close first: the rebound socket must bind the
						// same local port, which is still occupied until
						// now. The client's retry arrives ~600ms later,
						// long after the microsecond rebind window.
						localPort := udp.LocalAddr().(*net.UDPAddr).Port
						_ = udp.Close()
						dialConn, derr := net.DialUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: localPort}, peerAddr)
						if derr != nil {
							return
						}
						conn = dialConn
						rebound = true
						reboundCh <- dialConn
						continue
					}
					vars := make([]gosnmp.SnmpPDU, len(req.Variables))
					for i, requested := range req.Variables {
						value := interface{}([]byte("ESC/POS printer serial-123"))
						if tc.tag == gosnmp.ObjectIdentifier {
							value = "1.3.6.1.2.1"
						}
						vars[i] = gosnmp.SnmpPDU{Name: requested.Name + tc.suffix, Type: tc.tag, Value: value}
					}
					packet := gosnmp.SnmpPacket{Version: gosnmp.Version2c, Community: req.Community,
						PDUType: gosnmp.GetResponse, RequestID: req.RequestID, Variables: vars, Error: gosnmp.SNMPError(tc.status)}
					response, err := packet.MarshalMsg()
					if err != nil {
						return
					}
					// Replies go out on the rebound connected socket, so
					// they originate from the port the client dialed.
					if c, ok := conn.(*net.UDPConn); ok {
						_, _ = c.Write(response)
					}
				}
			}()
			defer func() {
				_ = udp.Close()
				select {
				case c := <-reboundCh:
					_ = c.Close()
				default:
				}
				<-done
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_, got := probeSNMPPrinterWithPort(ctx, "127.0.0.1", udp.LocalAddr().(*net.UDPAddr).Port, tcp.Addr().(*net.TCPAddr).Port)
			if got != tc.want {
				t.Fatalf("printer identity accepted = %v, want %v", got, tc.want)
			}
		})
	}
}
