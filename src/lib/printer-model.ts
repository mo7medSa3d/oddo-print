import { z } from "zod";
import { isPrivateNetworkAddress } from "./network-address";

export const PRINTER_TYPES = ["physical", "virtual", "redirected"] as const;
export const DEVICE_CLASSES = ["thermal", "laser", "inkjet", "label", "other", "unknown"] as const;
export const CONNECTION_TYPES = ["network", "usb", "spooler", "ipp", "ipps"] as const;
// "unknown" means "not declared": the capability model never routes to it.
export const PRINTER_PROTOCOLS = ["raw", "escpos", "zpl", "tspl", "ipp", "ipps", "spooler", "unknown"] as const;

export const printerInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).max(120).optional(),
  agentId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(100),
  printerType: z.enum(PRINTER_TYPES).default("physical"),
  deviceClass: z.enum(DEVICE_CLASSES).default("unknown"),
  connectionType: z.enum(CONNECTION_TYPES).default("network"),
  protocol: z.enum(PRINTER_PROTOCOLS),
  config: z.object({
    ip: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    vid: z.number().int().min(0).max(65535).optional(),
    pid: z.number().int().min(0).max(65535).optional(),
    serial: z.string().max(255).optional(),
    address: z.string().max(512).optional(),
    spooler_name: z.string().max(255).optional(),
    paper_widths: z.array(z.number().finite().positive().max(1000)).max(32).optional(),
    color_capable: z.boolean().optional(),
    duplex_capable: z.boolean().optional(),
  }).strict().default({}),
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type CanonicalPrinterInput = z.infer<typeof printerInputSchema>;
export const PRINTER_CONFIG_MAX_BYTES = 16 * 1024;
export const PRINTER_CAPABILITIES_MAX_BYTES = 32 * 1024;

export function assertPrinterMetadataLimits(input: Pick<CanonicalPrinterInput, "config" | "capabilities">): void {
  const configJson = JSON.stringify(input.config ?? {});
  if (Buffer.byteLength(configJson, "utf8") > PRINTER_CONFIG_MAX_BYTES) throw new Error("printer config exceeds 16KB");
  if (input.capabilities) {
    const capabilitiesJson = JSON.stringify(input.capabilities);
    if (Buffer.byteLength(capabilitiesJson, "utf8") > PRINTER_CAPABILITIES_MAX_BYTES) throw new Error("printer capabilities exceed 32KB");
  }
}

/**
 * Connection-transport sanity shared by the manager create route AND the
 * agent heartbeat upsert: a network printer without ip/port is unroutable
 * garbage, not a half-registered device. One rule, both boundaries.
 */
export function isAllowedPrinterDestination(ip: string): boolean {
  const host = ip.trim();
  // Reject the IPv4/IPv6 cloud-instance metadata endpoints even though they
  // are technically link-local/ULA destinations. A printer configuration
  // must never become a metadata-service proxy.
  if (host === "169.254.169.254" || host.toLowerCase() === "fd00:ec2::254") return false;
  return isPrivateNetworkAddress(host);
}

function validatePrivatePrinterHost(value: string): string | null {
  const host = value.trim();
  if (!host || !isAllowedPrinterDestination(host)) {
    return "printer network destination must be a private or link-local IP address";
  }
  return null;
}

function validateIPPPrinterAddress(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "IPP printer requires config.address";
  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return "invalid IPP printer URL";
  }
  if (!["http:", "https:", "ipp:", "ipps:"].includes(parsed.protocol.toLowerCase())) {
    return "IPP printer URL must use http, https, ipp, or ipps";
  }
  if (parsed.search || parsed.hash) {
    return "IPP printer URL cannot contain query strings or fragments";
  }
  if (!isAllowedPrinterDestination(parsed.hostname)) {
    return "printer network destination must be a private or link-local IP address";
  }
  return null;
}

function validatePrinterPort(connectionType: string, port: number): string | null {
  const allowed = connectionType === "network" ? new Set([9100]) : new Set([80, 443, 631]);
  if (!allowed.has(port)) {
    return connectionType === "network"
      ? "network printer port must be 9100"
      : "IPP printer port must be 80, 443, or 631";
  }
  return null;
}

export function validateConnectionConfig(connectionType: string, cfg: Record<string, unknown>): string | null {
  if (connectionType === "network") {
    if (!cfg.ip || typeof cfg.ip !== "string") return "network printer requires config.ip";
    if (!cfg.port || typeof cfg.port !== "number") return "network printer requires config.port";
    if (cfg.ip.includes(" ")) return "invalid network address";
    const addressErr = validatePrivatePrinterHost(cfg.ip);
    if (addressErr) return addressErr;
    const portErr = validatePrinterPort(connectionType, cfg.port);
    if (portErr) return portErr;
  }
  if (connectionType === "ipp" || connectionType === "ipps") {
    if (typeof cfg.address === "string" && cfg.address.trim()) {
      const addressErr = validateIPPPrinterAddress(cfg.address);
      if (addressErr) return addressErr;
      try {
        const parsed = new URL(cfg.address.includes("://") ? cfg.address : `http://${cfg.address}`);
        if (parsed.port) {
          const portErr = validatePrinterPort(connectionType, Number(parsed.port));
          if (portErr) return portErr;
        }
      } catch {
        return "invalid IPP printer URL";
      }
    } else if (typeof cfg.ip === "string" && cfg.ip.trim()) {
      const addressErr = validatePrivatePrinterHost(cfg.ip);
      if (addressErr) return addressErr;
      if (cfg.port !== undefined) {
        if (typeof cfg.port !== "number") return "IPP printer port is invalid";
        const portErr = validatePrinterPort(connectionType, cfg.port);
        if (portErr) return portErr;
      }
    } else {
      return "IPP printer requires config.address";
    }
  }
  if (connectionType === "spooler" && !(typeof cfg.spooler_name === "string" && cfg.spooler_name.trim()) && !(typeof cfg.address === "string" && cfg.address.trim())) {
    return "spooler printer requires config.spooler_name or config.address";
  }
  return null;
}

export function parsePrinterInput(value: unknown): CanonicalPrinterInput {
  const parsed = printerInputSchema.parse(value);
  assertPrinterMetadataLimits(parsed);
  return parsed;
}
