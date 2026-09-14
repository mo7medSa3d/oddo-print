import * as crypto from "node:crypto";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type Argon2Fn = (
  algorithm: "argon2id",
  params: { message: string; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number; version?: number },
  cb: (err: Error | null, derivedKey?: Buffer) => void,
) => void;

const ARGON_MEMORY = 64 * 1024;
const ARGON_PASSES = 3;
const ARGON_PARALLELISM = 4;
const ARGON_TAG_LENGTH = 32;
const ARGON_VERSION = 0x13;

function argon2(): Argon2Fn {
  const fn = (crypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (typeof fn !== "function") {
    throw new Error("Argon2id requires Node.js 24.7+ at runtime");
  }
  return fn;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2()("argon2id", {
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
