import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Local discovery results must carry the verified local Agent identity, or
// the desktop picker (which filters on agentId) drops every local result.
// The CLI stamps its paired Agent ID into each discovery record; the Rust
// IPC type preserves it; the dialog filters on it.
describe("local discovery to picker agent ownership", () => {
  it("stamps the paired agent id into CLI discovery JSON", () => {
    const cli = readFileSync("agent/cmd/cli/main.go", "utf8");
    expect(cli).toContain('AgentID string `json:"agentId,omitempty"`');
    expect(cli).toContain("ownedPrinter{DeviceInfo: device, AgentID: loaded.cfg.Agent.ID}");
  });

  it("preserves agentId across the Rust IPC boundary", () => {
    const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
    expect(commands).toContain('rename = "agentId"');
    expect(commands).toContain("pub agent_id: Option<String>");
  });

  it("filters local discovery by the selected agent instead of dropping it", () => {
    const dialog = readFileSync("src/desktop/components/AddPrinterDialog.tsx", "utf8");
    expect(dialog).toContain("p.agentId === agentId");
  });
});
