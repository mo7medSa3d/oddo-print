package agent

import (
	"context"
	"math/rand"
	"time"
)

const (
	wsReconnectInitialDelay  = 5 * time.Second
	wsReconnectMaxDelay      = 60 * time.Second
	wsReconnectStableSession = 30 * time.Second
)

// Handshake acceptance alone does not prove recovery: a proxy can accept and
// immediately close every session. Failed dials and short sessions share the
// same bounded retry budget; only a stable session resets it (RFC6455 7.2.3).
type wsReconnectBackoff struct {
	step time.Duration
}

func (b *wsReconnectBackoff) nextDelay(sessionDuration time.Duration) time.Duration {
	if b.step == 0 || sessionDuration >= wsReconnectStableSession {
		b.step = wsReconnectInitialDelay
	}
	delay := b.step/2 + time.Duration(rand.Int63n(int64(b.step/2)+1))
	b.step = min(b.step*2, wsReconnectMaxDelay)
	return delay
}

func waitForWSReconnect(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}
