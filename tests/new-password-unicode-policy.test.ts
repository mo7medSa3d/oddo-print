import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { screenNewPassword } from "../src/lib/password-screening";

describe("new-password Unicode length and existing-credential compatibility", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${"F".repeat(35)}:1\r\n`)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["😀".repeat(6), "Ab9!?xyZ😃🧪🔐"])("rejects a short new candidate before the breach lookup", async (password) => {
    expect(await screenNewPassword(password)).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["😀".repeat(12), "Ab9!?xyZ😃🧪🔐*"])("accepts a twelve-code-point candidate without changing it", async (password) => {
    expect(await screenNewPassword(password)).toBe("acceptable");
    const encoded = await hashPassword(password);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword(password + " ", encoded)).toBe(false);
  });

  it("keeps the 4096 UTF-16-code-unit resource ceiling", async () => {
    expect(await screenNewPassword("😀".repeat(2048))).toBe("acceptable");
    vi.mocked(fetch).mockClear();
    expect(await screenNewPassword("😀".repeat(2049))).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves existing six-emoji Argon2 credentials and legacy rehash compatibility", async () => {
    const existingPassword = "😀".repeat(6);
    const encoded = await hashPassword(existingPassword);
    expect(await verifyPassword(existingPassword, encoded)).toBe(true);
    expect(await verifyPassword("😀".repeat(5), encoded)).toBe(false);
  });
});
