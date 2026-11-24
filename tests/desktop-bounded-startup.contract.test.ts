import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Desktop bounded-startup contract (C037): privileged subprocesses carry
// timeouts and output caps, pipe-reader joins carry their own deadline, and
// app setup never blocks window creation on service control.
describe("desktop bounded startup and IPC", () => {
  it("bounds icacls through the shared bounded-command helper", () => {
    const paths = readFileSync("src-tauri/src/paths.rs", "utf8");
    expect(paths).not.toContain(".output()?;");
    expect(paths).toContain("crate::agent::run_bounded_command");
  });

  it("bounds pipe-reader joins against descendant-held pipes", () => {
    const agent = readFileSync("src-tauri/src/agent.rs", "utf8");
    expect(agent).toContain("fn join_reader_thread");
    expect(agent).toContain("recv_timeout");
    expect(agent).not.toContain("let _ = out_thread.join();");
    expect(agent).not.toContain("let _ = err_thread.join();");
  });

  it("starts the agent off the setup path", () => {
    const main = readFileSync("src-tauri/src/main.rs", "utf8");
    expect(main).toContain("std::thread::spawn");
    expect(main).toContain("agent::ensure_started(&handle)");
  });
});
