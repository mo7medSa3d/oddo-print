import { isIP } from "node:net";

export function isPrivateNetworkAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    // The EC2/IMDS host and ECS task-credential host are not printer
    // endpoints, despite being legal link-local IPv4 addresses.
    if (ip === "169.254.169.254" || ip === "169.254.170.2") return false;
    return isPrivateIPv4(ip);
  }
  if (family === 6) {
    // Compare numeric IPv6 addresses, not textual spellings: expanded
    // fd00:0ec2:0:0:0:0:0:0254 is the same metadata endpoint.
    const numeric = parseIPv6(ip);
    if (numeric === null || numeric === parseIPv6("fd00:ec2::254")) return false;
    return isPrivateIPv6Value(numeric);
  }
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function parseIPv6(ip: string): bigint | null {
  if (ip.includes("%")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  const total = left.length + right.length;
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total >= 8) return null;
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: 8 - total }, () => "0"), ...right]
    : left;
  let value = 0n;
  for (const part of groups) value = (value << 16n) | BigInt(parseInt(part, 16));
  return value;
}

function isPrivateIPv6Value(value: bigint): boolean {
  if (value === 0n || value === 1n) return false;
  const top7 = value >> 121n;
  const top10 = value >> 118n;
  return top7 === 0x7en || top10 === 0x3fan;
}
