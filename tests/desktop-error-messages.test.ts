import { describe, expect, it } from "vitest";
import {
  friendlyAgentError,
  friendlyGatewayError,
  friendlyPrinterError,
} from "../src/desktop/lib/printers";

describe("desktop friendly error mapping", () => {
  it("hides local agent config paths and permission details", () => {
    const message = friendlyAgentError(
      "load agent config failed: open C:\\ProgramData\\YasserAgent\\config.yaml: Access is denied."
    );

    expect(message).toBe(
      "Administrator permission is required to access the local Agent. Reopen Yasser Print Manager as Administrator and try again."
    );
    expect(message).not.toContain("ProgramData");
    expect(message).not.toContain("config.yaml");
  });


  it("sanitizes the same Agent-config failure when it bubbles through printer loading", () => {
    const message = friendlyPrinterError(
      "load agent config failed: open C:\\ProgramData\\YasserAgent\\config.yaml: Access is denied."
    );

    expect(message).toBe(
      "Administrator permission is required to access the local Agent. Reopen Yasser Print Manager as Administrator and try again."
    );
    expect(message).not.toContain("ProgramData");
    expect(message).not.toContain("Access is denied");
  });

  it("does not expose filesystem diagnostics from unexpected printer failures", () => {
    const message = friendlyPrinterError(
      "backend failure at C:\\ProgramData\\YasserAgent\\logs\\agent.log"
    );

    expect(message).toBe(
      "The printer operation could not be completed. Check the printer and try again."
    );
    expect(message).not.toContain("ProgramData");
    expect(message).not.toContain("agent.log");
  });

  it("turns Gateway transport failures into operator-safe guidance", () => {
    const message = friendlyGatewayError(
      "fetch failed: connect ECONNREFUSED 68.221.27.248:80"
    );

    expect(message).toBe(
      "The Gateway could not be reached. Check the Gateway URL and network connection, then try again."
    );
    expect(message).not.toContain("68.221.27.248");
    expect(message).not.toContain("ECONNREFUSED");
  });

  it("keeps pairing failures actionable without exposing the raw backend message", () => {
    const message = friendlyAgentError(
      "pairing code validation failed: backend rejected pairing code abc123"
    );

    expect(message).toBe(
      "Pairing could not be completed. Check the pairing code and make sure it has not expired."
    );
    expect(message).not.toContain("abc123");
  });
});
