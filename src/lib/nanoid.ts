import { randomBytes } from "node:crypto";

export function nanoid(size: number = 21): string {
  return randomBytes(Math.ceil((size * 3) / 4)).toString("base64url").slice(0, size);
}
