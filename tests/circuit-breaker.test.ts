import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/lib/circuit-breaker";

describe("CircuitBreaker", () => {
  it("rejects calls while open without invoking the protected operation", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000, name: "test" });
    await expect(breaker.execute(async () => {
      throw new Error("downstream failed");
    })).rejects.toThrow("downstream failed");

    let invoked = false;
    await expect(breaker.execute(async () => {
      invoked = true;
    })).rejects.toThrow("database operations suspended");
    expect(invoked).toBe(false);
  });

  it("allows exactly one recovery probe while half-open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0, name: "test" });
    await expect(breaker.execute(async () => {
      throw new Error("downstream failed");
    })).rejects.toThrow("downstream failed");
    expect(breaker.getState()).toBe("half-open");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstProbe = breaker.execute(async () => {
      await gate;
    });

    await expect(breaker.execute(async () => {
      throw new Error("second probe");
    })).rejects.toThrow("recovery probe already in progress");

    release();
    await firstProbe;
    expect(breaker.getState()).toBe("closed");
  });
  it("ignores earlier-generation completions after a concurrent failure opens the circuit", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000, name: "generation" });
    let release!: () => void;
    const delayed = breaker.execute(() => new Promise<void>(resolve => { release = resolve; }));
    await expect(breaker.execute(async () => { throw new Error("down"); })).rejects.toThrow("down");
    release(); await delayed;
    expect(breaker.getState()).toBe("open");
    let called = false;
    await expect(breaker.execute(async () => { called = true; })).rejects.toThrow("suspended");
    expect(called).toBe(false);
  });

});
