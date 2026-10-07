import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pairing must converge the running runtime (C041): the Agent holds its
// initial config in memory, so saving credentials without a restart leaves
// the runtime on the OLD connection while consoles use the NEW identity.
// Agent-console requests must prove origin agreement (C053): the Manager
// origin and the paired Agent origin are distinct identities.
describe("pairing activation and console origin ownership", () => {
  it("restarts a running agent after pairing and reports activation state", () => {
    const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
    expect(commands).toContain("let was_running = agent::status(&app).0;");
    expect(commands).toContain("agent::restart(&app)");
    expect(commands).toContain("agent restarted with the new identity");
    expect(commands).toContain("saved; start the agent to activate");
  });

  it("threads the expected origin from desktop through Rust to the CLI", () => {
    const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
    const ipc = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    expect(commands).toContain("pub expected_origin: String");
    expect(commands).toContain('"-expect-origin"');
    expect(ipc).toContain("expected_origin: base");
  });

  it("refuses console requests when the paired origin disagrees", () => {
    const cli = readFileSync("agent/cmd/cli/gateway.go", "utf8");
    expect(cli).toContain("normalizeOriginForCompare");
    expect(cli).toContain("paired Agent Gateway origin differs from the requested Manager origin");
  });
});
