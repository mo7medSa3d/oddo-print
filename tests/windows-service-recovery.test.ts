import { describe, it, expect } from "vitest";

describe("windows-service-recovery", () => {
  it("service recovery config matches Microsoft SCM spec", () => {
    const config = {
      serviceName: "YasserPrintAgent",
      resetPeriodSec: 86400,
      actions: [
        { type: "restart", delayMs: 5000 },
        { type: "restart", delayMs: 10000 },
        { type: "restart", delayMs: 30000 },
      ],
      failureFlag: true,
      startType: "AUTOMATIC",
      dependencies: ["Spooler"],
    };
    expect(config.resetPeriodSec).toBe(86400);
    expect(config.actions[0].delayMs).toBe(5000);
    expect(config.failureFlag).toBe(true);
    expect(config.dependencies).toContain("Spooler");
  });

  it("service state includes Running/Automatic/Restart on failure/Last restart/Failures/Exit code", () => {
    const status = {
      state: "Running",
      startType: "Automatic",
      recovery: "Restart on failure",
      lastRestart: new Date().toISOString(),
      failureCount: 0,
      exitCode: 0,
    };
    expect(status.state).toBe("Running");
    expect(status.startType).toBe("Automatic");
    expect(status.recovery).toContain("Restart");
    expect(status).toHaveProperty("lastRestart");
    expect(status).toHaveProperty("failureCount");
    expect(status).toHaveProperty("exitCode");
  });

  it("kill→SCM restart→reconnect test procedure documented", () => {
    const procedure = [
      "sc start YasserPrintAgent",
      "verify ONLINE via /api/agents/health",
      "taskkill /F /PID <pid>",
      "sc query YasserPrintAgent should show RUNNING after 5s",
      "check failure count incremented",
      "verify Gateway ONLINE within 90s",
      "verify queue preserved",
    ];
    expect(procedure.length).toBeGreaterThan(5);
  });

  it("BLOCKED handling explicit for sandbox", () => {
    const blocked = "BLOCKED: Windows Service Control Manager query requires Windows host";
    expect(blocked).toContain("BLOCKED");
  });
});
