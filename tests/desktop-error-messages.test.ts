import { describe, expect, it } from "vitest";
import { friendlyAgentError, friendlyGatewayError } from "../src/desktop/lib/printers";

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
