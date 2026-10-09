import { createHash } from "node:crypto";

/**
 * Stable, server-created identity of the observation a Manager has actually
 * reviewed. Never accept this value from an Agent: it is derived exclusively
 * from the committed discovered_devices row. Include all fields subsequently
 * used to choose a print target or initialize a printer.
 *
 * Object key ordering in agent capabilities is not semantically meaningful;
 * normalizing it avoids invalidating unchanged observations on JSONB reads.
 */
export type DiscoveryObservation = {
  id: string;
  tenantId: string;
  agentId: string;
  discoveryId: string;
  identityKey?: string | null;
  protocol: string;
  ipAddress?: string | null;
  hostname?: string | null;
  port?: number | null;
  uri?: string | null;
  spoolerName?: string | null;
  deviceName?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  macAddress?: string | null;
  transport?: string | null;
  deviceClass: string;
  capabilities?: Record<string, unknown> | null;
};

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stableJson(v)]),
    );
  }
  return value ?? null;
}

export function discoveryObservationFingerprint(device: DiscoveryObservation): string {
  const snapshot = [
    "YASEIR_DISCOVERY_OBSERVATION_V1",
    device.tenantId, device.agentId, device.id, device.discoveryId,
    device.identityKey ?? null,
    device.protocol, device.ipAddress ?? null, device.hostname ?? null,
    device.port ?? null, device.uri ?? null, device.spoolerName ?? null,
    device.deviceName ?? null, device.manufacturer ?? null, device.model ?? null,
    device.serialNumber ?? null, device.macAddress ?? null, device.transport ?? null,
    device.deviceClass, stableJson(device.capabilities ?? null),
  ];
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
