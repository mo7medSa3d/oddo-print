import { describe, expect, it } from "vitest";
import { BoundedQueryRunner } from "../src/lib/bounded-query";

describe("bounded diagnostic query admission", () => {
  it("keeps the pool budget occupied after callers time out until server work settles", async () => {
    const runner = new BoundedQueryRunner(2);
    let finishA!: (value: string) => void;
    let finishB!: (value: string) => void;
    const a = new Promise<string>((resolve) => { finishA = resolve; });
    const b = new Promise<string>((resolve) => { finishB = resolve; });

    await Promise.all([
      expect(runner.run(() => a, 15, "A")).rejects.toThrow("DB timeout A"),
      expect(runner.run(() => b, 15, "B")).rejects.toThrow("DB timeout B"),
    ]);
    expect(runner.activeCount).toBe(2);
    let entered = false;
    await expect(runner.run(async () => { entered = true; return "C"; }, 50, "C"))
      .rejects.toThrow("DB diagnostics overloaded");
    expect(entered).toBe(false);

    finishA("ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.activeCount).toBe(1);
    await expect(runner.run(async () => "D", 50, "D")).resolves.toBe("D");
    finishB("ok");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.activeCount).toBe(0);
  });

  it("releases after a late rejection and catches synchronous query errors", async () => {
    const runner = new BoundedQueryRunner(1);
    let fail!: (reason: Error) => void;
    const blocked = new Promise<void>((_, reject) => { fail = reject; });
    await expect(runner.run(() => blocked, 10, "blocked")).rejects.toThrow("DB timeout blocked");
    fail(new Error("backend terminated"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.activeCount).toBe(0);
    await expect(runner.run(() => { throw new Error("synchronous"); }, 50, "sync"))
      .rejects.toThrow("synchronous");
    expect(runner.activeCount).toBe(0);
    await expect(runner.run(async () => 1, 50, "recovered")).resolves.toBe(1);
  });

  it("rejects invalid limits without creating queries", () => {
    expect(() => new BoundedQueryRunner(0)).toThrow();
    expect(() => new BoundedQueryRunner(1.5)).toThrow();
  });
});
