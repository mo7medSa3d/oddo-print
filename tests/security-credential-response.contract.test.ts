import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("credential response security", () => {
  it("never permits generated Odoo API keys to be cached by intermediaries", () => {
    const files = [
      path.join(root, "src/app/api/odoo/keys/route.ts"),
      path.join(root, "src/app/api/odoo/keys/[id]/rotate/route.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).toContain('"Cache-Control": "no-store"');
      expect(source).toContain("apiKey:");
    }
  });
});

describe("Agent credential response security", () => {
  it("marks one-time Agent pairing credentials as non-cacheable", () => {
    const source = fs.readFileSync(path.join(root, "src/app/api/agent/register/route.ts"), "utf8");
    expect(source).toContain('secret: outcome.secret');
    expect(source).toContain('agent_secret: outcome.secret');
    expect(source).toContain('"Cache-Control": "no-store"');
  });
});
