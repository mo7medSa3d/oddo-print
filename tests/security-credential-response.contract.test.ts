import fs from "node:fs";
import path from "node:path";

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
