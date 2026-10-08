export const GATEWAY_FAILURES_BEFORE_OFFLINE = 3;
export const GATEWAY_OUTAGE_CONFIRMATION_MS = 60_000;

export interface GatewayConnectivityEvidence {
  origin: string;
  lastSuccessAt: number;
  lastFailureAt: number;
  consecutiveFailures: number;
}

export interface GatewayFailureObservation {
  evidence: GatewayConnectivityEvidence;
  confirmedOffline: boolean;
}

export function emptyGatewayConnectivityEvidence(origin = ""): GatewayConnectivityEvidence {
  return {
    origin,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    consecutiveFailures: 0,
  };
}

export function noteGatewayConnectivitySuccess(
  previous: GatewayConnectivityEvidence,
  origin: string,
  nowMs: number,
): GatewayConnectivityEvidence {
  return {
    origin,
    lastSuccessAt: nowMs,
    lastFailureAt: previous.origin === origin ? previous.lastFailureAt : 0,
    consecutiveFailures: 0,
  };
}

export function noteGatewayConnectivityFailure(
  previous: GatewayConnectivityEvidence,
  origin: string,
  nowMs: number,
): GatewayFailureObservation {
  const sameOrigin = previous.origin === origin;
  const lastSuccessAt = sameOrigin ? previous.lastSuccessAt : 0;
  const consecutiveFailures = sameOrigin ? previous.consecutiveFailures + 1 : 1;
  const lastFailureAt = nowMs;
  const hadSuccess = lastSuccessAt > 0;
  const silenceMs = hadSuccess ? Math.max(0, nowMs - lastSuccessAt) : Number.POSITIVE_INFINITY;

  // A saved Gateway that has never succeeded in this process can be shown as
  // unavailable after its first failed verification. Once a Gateway has been
  // positively observed, however, transient DNS/TLS/Wi-Fi failures must not
  // flap the UI. Require both repeated failures and a full minute without any
  // positive evidence before publishing an outage.
  const confirmedOffline = !hadSuccess || (
    consecutiveFailures >= GATEWAY_FAILURES_BEFORE_OFFLINE &&
    silenceMs >= GATEWAY_OUTAGE_CONFIRMATION_MS
  );

  return {
    evidence: {
      origin,
      lastSuccessAt,
      lastFailureAt,
      consecutiveFailures,
    },
    confirmedOffline,
  };
}
