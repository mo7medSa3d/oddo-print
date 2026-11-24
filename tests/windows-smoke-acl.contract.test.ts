import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows smoke ACL contract", () => {
  it("tests only atomic write-capable rights and does not flag read-only Synchronize access", () => {
    const source = readFileSync("scripts/smoke-test-windows.ps1", "utf8");

    for (const right of [
      "WriteData",
      "AppendData",
      "WriteExtendedAttributes",
      "WriteAttributes",
      "DeleteSubdirectoriesAndFiles",
      "Delete",
      "ChangePermissions",
      "TakeOwnership",
    ]) {
      expect(source).toContain(`FileSystemRights]::${right}`);
    }

    const assignment = source.match(/\$dangerousRights\s*=\s*\([\s\S]*?\n\s*\)/)?.[0] ?? "";
    expect(assignment).not.toContain("FileSystemRights]::Write -bor");
    expect(assignment).not.toContain("FileSystemRights]::Modify");
    expect(assignment).not.toContain("FileSystemRights]::Synchronize");
  });
});
