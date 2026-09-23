import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendTransactionalEmail } from "../src/lib/email";

describe("HTTP test email capture", () => {
  it("captures verification email content only in explicit HTTP test mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yasser-email-capture-"));
    const file = join(dir, "verification-email.txt");
    const previousMode = process.env.YASSER_HTTP_TEST_MODE;
    const previousFile = process.env.YASSER_TEST_EMAIL_CAPTURE_FILE;
    try {
      process.env.YASSER_HTTP_TEST_MODE = "1";
      process.env.YASSER_TEST_EMAIL_CAPTURE_FILE = file;

      await sendTransactionalEmail({
        to: "test@example.invalid",
        subject: "Verify your Yasser account",
        html: "<p>Verify</p>",
        text: "Verify your Yasser account: http://127.0.0.1/verify-email?token=test-token",
      });

      const captured = readFileSync(file, "utf8");
      expect(captured).toContain("TO: test@example.invalid");
      expect(captured).toContain("Verify your Yasser account");
      expect(captured).toContain("http://127.0.0.1/verify-email?token=test-token");
    } finally {
      if (previousMode === undefined) delete process.env.YASSER_HTTP_TEST_MODE;
      else process.env.YASSER_HTTP_TEST_MODE = previousMode;
      if (previousFile === undefined) delete process.env.YASSER_TEST_EMAIL_CAPTURE_FILE;
      else process.env.YASSER_TEST_EMAIL_CAPTURE_FILE = previousFile;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
