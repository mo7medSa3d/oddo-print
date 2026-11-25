import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeGatewayUrl } from "../src/desktop/lib/ipc";
import {
  PAIRED_ORIGIN_STORAGE_KEY,
  forgetPairedOrigin,
  pairingConfirmedFor,
  readPersistedPairedOrigin,
  rememberPairedOrigin,
} from "../src/desktop/lib/pairing-origin";

const savedWindow = globalThis.window;

function storage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("durable desktop pairing origin", () => {
  let local: ReturnType<typeof storage>;

  beforeEach(() => {
    local = storage();
    globalThis.window = { localStorage: local } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    globalThis.window = savedWindow;
  });

  it("only confirms pairing for the exact saved gateway origin", () => {
    expect(pairingConfirmedFor("https://gw.example.com", "")).toBe(false);
    expect(pairingConfirmedFor(null, "https://gw.example.com")).toBe(false);
    expect(pairingConfirmedFor("https://other.example.com", "https://gw.example.com")).toBe(false);
    expect(pairingConfirmedFor("https://gw.example.com", "not a url")).toBe(false);
    expect(pairingConfirmedFor("https://gw.example.com/", "https://gw.example.com")).toBe(true);
  });

  it("rehydrates an authenticated pairing after an app restart", () => {
    rememberPairedOrigin("https://gw.example.com/");
    expect(local.values.get(PAIRED_ORIGIN_STORAGE_KEY)).toBe(normalizeGatewayUrl("https://gw.example.com/"));
    expect(readPersistedPairedOrigin()).toBe(normalizeGatewayUrl("https://gw.example.com"));
    expect(pairingConfirmedFor(readPersistedPairedOrigin(), "https://gw.example.com")).toBe(true);
  });

  it("forgets the previous pairing when the gateway origin changes", () => {
    rememberPairedOrigin("https://gw.example.com");
    forgetPairedOrigin();
    expect(local.values.has(PAIRED_ORIGIN_STORAGE_KEY)).toBe(false);
    expect(pairingConfirmedFor(readPersistedPairedOrigin(), "https://gw.example.com")).toBe(false);
  });

  it("ignores corrupt persisted values instead of claiming a pairing", () => {
    local.values.set(PAIRED_ORIGIN_STORAGE_KEY, "not a url");
    expect(readPersistedPairedOrigin()).toBeNull();
    expect(pairingConfirmedFor(readPersistedPairedOrigin(), "https://gw.example.com")).toBe(false);
  });
});
