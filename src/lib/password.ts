import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";

type Argon2Fn = typeof argon2;

const ARGON_MEMORY = 64 * 1024;
const ARGON_PASSES = 3;
const ARGON_PARALLELISM = 4;
const ARGON_TAG_LENGTH = 32;
const ARGON_VERSION = 0x13;
// NOTE: verifyPassword pins stored hashes to exactly these parameters and
// fails closed otherwise. Raising any cost parameter therefore invalidates
// ALL existing hashes (users locked out until password reset) unless a
// needsRehash-style upgrade path is added first. Treat a bump as a migration,
// not a constant tweak.

function argon2OrThrow(): Argon2Fn {
  // The built-in exists since Node 24.7 (engines pin >=24.15); feature-detect
  // instead of assuming so a stripped runtime fails with a clear message.
  const candidate: unknown = argon2;
  if (typeof candidate !== "function") {
    throw new Error("Argon2id requires Node.js 24.7+ at runtime");
  }
  return candidate as Argon2Fn;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2OrThrow()("argon2id", {
      message: password,
      nonce: salt,
      parallelism: ARGON_PARALLELISM,
      tagLength: ARGON_TAG_LENGTH,
      memory: ARGON_MEMORY,
      passes: ARGON_PASSES,
      version: ARGON_VERSION,
    }, (err, key) => err ? reject(err) : resolve(key!));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || password.length > 4096) {
    throw new Error("Password must be 12-4096 characters");
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `argon2id$v=19$m=${ARGON_MEMORY},t=${ARGON_PASSES},p=${ARGON_PARALLELISM}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof encoded !== "string" || !encoded.startsWith("argon2id$")) return false;
  const parts = encoded.split("$");
  if (parts.length !== 5) return false;
  const params = parts[2];
  const match = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(params);
  if (!match || Number(match[1]) !== ARGON_MEMORY || Number(match[2]) !== ARGON_PASSES || Number(match[3]) !== ARGON_PARALLELISM) return false;
  let salt: Buffer, expected: Buffer;
  try { salt = Buffer.from(parts[3], "base64url"); expected = Buffer.from(parts[4], "base64url"); } catch { return false; }
  if (salt.length < 16 || expected.length !== ARGON_TAG_LENGTH) return false;
  const actual = await derive(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function hashToken(token: string): Promise<string> {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
