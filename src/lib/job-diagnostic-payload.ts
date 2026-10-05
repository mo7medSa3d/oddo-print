import { createHash } from "node:crypto";

export type JobDiagnosticPayload = {
  type: string | null;
  encoding: string | null;
  protocol: string | null;
  peripherals: Record<string, string> | null;
  data: {
    redacted: true;
    base64Characters: number;
    decodedBytes: number | null;
    sha256: string | null;
  } | null;
};

function safeEnum(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

const PAYLOAD_TYPES = ["raw", "escpos", "pdf", "image"] as const;
const PAYLOAD_ENCODINGS = ["base64"] as const;
const RAW_PROTOCOLS = ["raw", "escpos", "zpl", "tspl"] as const;
const PERIPHERAL_VALUES = {
  drawer: ["pin2", "pin5", "none"],
  cutter: ["partial", "full", "none"],
  buzzer: ["epson_pulse", "star_bel", "none"],
} as const;

function safePeripherals(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["drawer", "cutter", "buzzer"] as const) {
    const safe = safeEnum(input[key], PERIPHERAL_VALUES[key]);
    if (safe) out[key] = safe;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Produce an operator-safe description of a stored print payload.
 *
 * Raw print bytes are deliberately never returned: PDF/image/label/receipt
 * payloads may contain customer PII.  Size + SHA-256 are enough to prove what
 * byte sequence was admitted and to correlate it with Agent-side diagnostics.
 */
export function buildJobDiagnosticPayload(payload: unknown): JobDiagnosticPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const input = payload as Record<string, unknown>;
  const rawData = typeof input.data === "string" ? input.data : null;

  let data: JobDiagnosticPayload["data"] = null;
  if (rawData !== null) {
    let decodedBytes: number | null = null;
    let sha256: string | null = null;
    try {
      const decoded = Buffer.from(rawData, "base64");
      // Stored payloads are validated on admission. Re-check canonical base64
      // here so a legacy/corrupt row cannot produce a misleading byte digest.
      if (decoded.length > 0 && decoded.toString("base64") === rawData) {
        decodedBytes = decoded.length;
        sha256 = createHash("sha256").update(decoded).digest("hex");
      }
    } catch {
      // Diagnostic rendering must remain available for corrupt legacy rows.
    }
    data = {
      redacted: true,
      base64Characters: rawData.length,
      decodedBytes,
      sha256,
    };
  }

  return {
    type: safeEnum(input.type, PAYLOAD_TYPES),
    encoding: safeEnum(input.encoding, PAYLOAD_ENCODINGS),
    protocol: safeEnum(input.protocol, RAW_PROTOCOLS),
    peripherals: safePeripherals(input.peripherals),
    data,
  };
}
