import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { runtimeSecret } from "./runtime-secret";

const MAX_FILE_BYTES = 256;
const KEY_PATTERN = /^[a-fA-F0-9]{64}(?:\r?\n)?$/;
const KNOWN_SECRET_NAMES = ["GATEWAY_JWT_SECRET", "TRUST_PROXY_SECRET"] as const;

export class MetricsMachineConfigurationError extends Error {
  constructor() {
    super("Configured metrics credential must be a readable regular file containing an independent 32-byte hexadecimal key.");
    this.name = "MetricsMachineConfigurationError";
  }
}

function assertIndependent(key: Buffer): void {
  for (const name of KNOWN_SECRET_NAMES) {
    const known = runtimeSecret(name);
    if (!known || !/^[a-fA-F0-9]{64}$/.test(known)) continue;
    // Hexadecimal case is an encoding choice, not a different secret.
    const candidate = Buffer.from(known, "hex");
    try {
      if (timingSafeEqual(key, candidate)) throw new MetricsMachineConfigurationError();
    } finally { candidate.fill(0); }
  }
}

function configuredKey(): Buffer | null {
  const file = process.env.METRICS_SCRAPE_TOKEN_FILE?.trim();
  if (!file) return null;
  // Read the opened descriptor, never stat(path) then readFile(path). A fixed
  // extra byte detects growth beyond the limit without allocating by size.
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  try {
    let descriptor: number | undefined;
    let length = 0;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      const before = noFollow ? null : lstatSync(file);
      if (before && (!before.isFile() || before.isSymbolicLink())) throw new MetricsMachineConfigurationError();
      descriptor = openSync(file, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES
        || (before && (before.dev !== stat.dev || before.ino !== stat.ino))) {
        throw new MetricsMachineConfigurationError();
      }
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const value = bytes.subarray(0, length).toString("utf8");
    if (length > MAX_FILE_BYTES || !KEY_PATTERN.test(value)) throw new MetricsMachineConfigurationError();
    const key = Buffer.from(value.slice(0, 64), "hex");
    try {
      assertIndependent(key);
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  } catch {
    // Neither filesystem diagnostics nor configured values belong in an
    // HTTP response or startup log. No cached authority survives a failure.
    throw new MetricsMachineConfigurationError();
  } finally { bytes.fill(0); }
}

export function assertMetricsMachineConfiguration(): void {
  const key = configuredKey();
  key?.fill(0);
}

/** This authority is intentionally local to the single read-only scrape. */
export function isMetricsMachineRequest(req: Request): boolean {
  const key = configuredKey();
  if (!key) return false;
  try {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/api/metrics" || url.search || url.hash) return false;
    // Merged duplicate fields contain a comma and cannot match this grammar.
    const match = /^Bearer ([a-fA-F0-9]{64})$/.exec(req.headers.get("authorization") ?? "");
    if (!match) return false;
    const supplied = Buffer.from(match[1], "hex");
    try { return timingSafeEqual(key, supplied); }
    finally { supplied.fill(0); }
  } finally { key.fill(0); }
}
