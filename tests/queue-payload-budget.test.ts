import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import payloadContract from "../contracts/print-payload-contract.json";

describe("License-only control plane: queue payload budget retired", () => {
  it("removes print-job-service and preserves normative 5 MiB wire payload contract", () => {
    expect(existsSync("src/lib/print-job-service.ts")).toBe(false);
    expect(payloadContract.maxPayloadBytes).toBe(5 * 1024 * 1024);
    expect(readFileSync("src/db/schema.ts", "utf8")).not.toMatch(/pgTable\("print_jobs"/);
  });
});
